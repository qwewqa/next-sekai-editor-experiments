#!/usr/bin/env python3
"""The independent checker for .nxsp v1 files.

Standard library only, sharing no code with the editor: it reads `fields-v1.json` (a copy that
`npm run format:gen` writes beside it) and checks what a v1 writer must write: every ZIP header pin,
the entry order and methods, CRCs, the end record, `project.json` and its pointers, the reader caps,
every record's arity and types, the roots and nodes under their own hashes, `chunks.bin` tiling,
every chunk inflated with the strict end check and hashed, the closure of every root, `summary`,
`history.entries`, the undo stack, and `revision.completeFrom`, placed and, when the file of the
revision it names (or one between) is also given, checked against that file's rows. A file it
passes also opens fully in its reader mode.

With `--read` it is a second v1 reader instead, for files a writer doesn't make (an OS re-zip, a
partial file): it prints, as one JSON line per file, what the editor's reader opens (`full`, or
`partial` with its reasons, `unreadable` or `not-project`), checking only what an open checks.

    uv run python -I tools/nxsp_check.py FILE...
    uv run python -I tools/nxsp_check.py --read FILE...
    uv run python -I tools/nxsp_check.py --show FILE HASH
"""

import hashlib
import json
import math
import os
import re
import struct
import sys
import unicodedata
import zlib

# Huge integer literals (400+ digits) must parse, as JSON.parse reads them: a big double or Infinity.
if hasattr(sys, "set_int_max_str_digits"):
    sys.set_int_max_str_digits(0)

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "fields-v1.json"), encoding="utf-8") as f:
    FIELDS = json.load(f)

MB = 1024 * 1024
CAPS = {"project": MB, "level": 64 * MB, "manifest": 256 * MB, "history": 512 * MB, "chunks": 2048 * MB,
        "chunk": 16 * MB, "media": 1024 * MB, "depth": 64, "entries": 65535, "segments": 4096}
SAFE = 2 ** 53 - 1
HEX16 = re.compile(r"^[0-9a-f]{32}$")
HEX32 = re.compile(r"^[0-9a-f]{64}$")
ENTRY_KINDS = {"init", "continue", "edit", "undo", "redo", "restore", "save", "export", "recovered"}
STORE_PREFIXES = ("history/chunks.bin", "assets/", "bgm/")
# A segment copied whole from a stored source segment stays stored.
EITHER_PREFIXES = ("history/segments/",)


class Fail(Exception):
    pass


def need(ok, message):
    if not ok:
        raise Fail(message)


# JSON

def depth_of(text):
    depth = deepest = 0
    in_string = escaped = False
    for c in text:
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif c in "]}":
            depth -= 1
    return deepest


def reject_constant(name):
    raise Fail(f"JSON constant {name}")


def parse_json(data, what):
    need(not data.startswith(b"\xef\xbb\xbf"), f"{what}: a byte-order mark")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise Fail(f"{what}: not UTF-8")
    need(depth_of(text) <= CAPS["depth"], f"{what}: nested deeper than {CAPS['depth']}")
    try:
        return json.loads(text, parse_constant=reject_constant)
    except ValueError as error:
        raise Fail(f"{what}: {error}")


def finite(v):
    """A parsed number as a JS double: an integer literal past the double range is Infinity."""
    try:
        return math.isfinite(float(v))
    except OverflowError:
        return False


def is_int(v):
    return not isinstance(v, bool) and isinstance(v, (int, float)) and finite(v) and float(v).is_integer()


def is_uint(v):
    return is_int(v) and 0 <= v <= SAFE


def is_id(v):
    return is_int(v) and 0 < v <= SAFE


def is_number(v):
    return not isinstance(v, bool) and isinstance(v, (int, float)) and finite(v)


def num_is(v, n):
    """Equal to the integer `n` as JSON.parse reads it (`1.0` is 1), never a boolean."""
    return is_int(v) and v == n


def js_number(x):
    """A number as JS's Number::toString writes it (`1`, not `1.0`; `1e+21`, not `1e21`)."""
    if isinstance(x, int):
        if -SAFE <= x <= SAFE:
            return str(x)
        x = float(x)
    if x == 0:
        return "0"
    text = repr(x)
    sign = "-" if text.startswith("-") else ""
    mantissa, _, exp = text.lstrip("-").partition("e")
    whole, _, fraction = mantissa.partition(".")
    significant = (whole + fraction).lstrip("0")
    digits = significant.rstrip("0")
    k = len(digits)
    n = k + int(exp or 0) - len(fraction) + (len(significant) - k)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * -n + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e > 0 else "-") + str(abs(e))
    return sign + out


SURROGATE = re.compile("[\ud800-\udfff]")
ARRAY_INDEX = re.compile(r"^(0|[1-9][0-9]*)$")


def js_json(value):
    """JSON.stringify of a parsed value: JS numbers, lone surrogates escaped, index keys first."""
    if value is None:
        return "null"
    if value is True or value is False:
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", json.dumps(value, ensure_ascii=False))
    if isinstance(value, list):
        return "[" + ",".join(js_json(x) for x in value) + "]"
    keys = list(value)
    index = sorted((k for k in keys if ARRAY_INDEX.fullmatch(k) and int(k) < 2 ** 32 - 1), key=int)
    keys = index + [k for k in keys if k not in set(index)]
    return "{" + ",".join(js_json(k) + ":" + js_json(value[k]) for k in keys) + "}"


def is_str(v):
    return isinstance(v, str)


def is_hash(v):
    return isinstance(v, str) and HEX16.fullmatch(v) is not None


def keys_within(obj, allowed, what):
    need(isinstance(obj, dict), f"{what}: not an object")
    extra = set(obj) - set(allowed)
    need(not extra, f"{what}: unknown keys {sorted(extra)}")


# Records (from fields-v1.json)

def check_type(t, v, path):
    if t == "id":
        need(is_id(v), f"{path}: not an id")
    elif t == "uint":
        need(is_uint(v), f"{path}: not a uint")
    elif t == "number":
        need(is_number(v), f"{path}: not a finite number")
    elif t == "bool":
        need(isinstance(v, bool), f"{path}: not a boolean")
    elif t == "string":
        need(is_str(v), f"{path}: not a string")
    elif t == "hash16":
        need(is_hash(v), f"{path}: not a hash")
    elif t == "mediaRefOrEmpty":
        need(isinstance(v, list), f"{path}: not an array")
        if v:
            check_record("mediaRef", v, path)
    elif t.startswith("enum:"):
        need(is_str(v) and v in FIELDS["enums"][t[5:]], f"{path}: not a value of {t[5:]}")
    elif t.startswith("array:"):
        need(isinstance(v, list), f"{path}: not an array")
        item = t[6:]
        for i, x in enumerate(v):
            if item in FIELDS and item not in ("kinds", "kindOrder", "enums"):
                check_record(item, x, f"{path}[{i}]")
            else:
                check_type(item, x, f"{path}[{i}]")
    elif t.startswith("record:"):
        check_record(t[7:], v, path)
    else:
        raise Fail(f"unknown field type {t}")


def check_record(name, v, path):
    form = FIELDS[name]
    if isinstance(form, dict):
        check_type(form["type"], v, path)
        need(len(v) >= form.get("minItems", 0), f"{path}: too few items")
        return
    need(isinstance(v, list), f"{path}: not an array")
    required = sum(1 for field in form if not field.get("optional"))
    need(required <= len(v) <= len(form), f"{path}: {len(v)} positions")
    for field, x in zip(form, v):
        check_type(field["type"], x, f"{path}.{field['name']}")
        if "minItems" in field:
            need(len(x) >= field["minItems"], f"{path}.{field['name']}: too few items")


def check_header_refs(header, path):
    ids = {}
    for key, at in (("groups", 3), ("stages", 4), ("groupFolders", 5), ("stageFolders", 6)):
        seen = [r[0] for r in header[at]]
        need(len(seen) == len(set(seen)), f"{path}.{key}: an id twice")
        ids[key] = set(seen)
    need(not (ids["groupFolders"] & ids["stageFolders"]), f"{path}: a folder id in both maps")
    for at, key, ref in ((3, "groups", "groupFolders"), (4, "stages", "stageFolders")):
        for r in header[at]:
            if len(r) == len(FIELDS[key[:-1]]):
                need(r[-1] in ids[ref], f"{path}.{key}: folder {r[-1]} missing")
    for at, key in ((5, "groupFolders"), (6, "stageFolders")):
        parents = {r[0]: r[3] for r in header[at] if len(r) == 4}
        for r in header[at]:
            seen, at_id = set(), r[0]
            while at_id in parents:
                need(at_id not in seen, f"{path}.{key}: folder {r[0]} loops")
                seen.add(at_id)
                need(parents[at_id] in ids[key], f"{path}.{key}: folder {parents[at_id]} missing")
                at_id = parents[at_id]
    return ids


def check_refs(form_name, record, ids, path):
    form = FIELDS[form_name]
    if isinstance(form, dict):
        for i, x in enumerate(record):
            check_refs(form["type"][6:], x, ids, f"{path}[{i}]")
        return
    for field, x in zip(form, record):
        ref = field.get("ref")
        if ref and ref != "folders":
            need(x in ids[ref], f"{path}.{field['name']}: {ref} {x} missing")


# `revision.savedAt` as a reader takes it: RFC 3339 `date-time` and nothing looser, else absent.

SAVED_AT = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))")


def parse_saved_at(value):
    """Epoch milliseconds, or None: uppercase T and Z, a date that exists, seconds 00-59, an offset of hh:mm."""
    if not isinstance(value, str):
        return None
    m = SAVED_AT.fullmatch(value)
    if m is None:
        return None
    year, month, day, hour, minute, second = (int(m.group(i)) for i in range(1, 7))
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = 29 if month == 2 and leap else [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] if 1 <= month <= 12 else 0
    off_hour, off_minute = (int(m.group(8)), int(m.group(9))) if m.group(7) else (0, 0)
    if not (1 <= day <= days) or hour > 23 or minute > 59 or second > 59 or off_hour > 23 or off_minute > 59:
        return None
    y = year - (month <= 2)
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    epoch_days = era * 146097 + doe - 719468
    offset = (off_hour * 60 + off_minute) * 60000 * (-1 if m.group(7) == "-" else 1)
    return ((epoch_days * 24 + hour) * 60 + minute) * 60000 + second * 1000 - offset


# ZIP

def dos_of(saved_at):
    m = re.fullmatch(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z", saved_at)
    need(m is not None, f"revision.savedAt {saved_at!r}: not ISO 8601 UTC to the second")
    y, mo, d, h, mi, s = (int(x) for x in m.groups())
    if y < 1980:
        y, mo, d, h, mi, s = 1980, 1, 1, 0, 0, 0
    elif (y, mo, d, h, mi, s) > (2107, 12, 31, 23, 59, 58):
        y, mo, d, h, mi, s = 2107, 12, 31, 23, 59, 58
    return (h << 11) | (mi << 5) | (s // 2), ((y - 1980) << 9) | (mo << 5) | d


def inflate_strict(data, size, what):
    d = zlib.decompressobj(-15)
    try:
        out = d.decompress(data, size + 1)
    except zlib.error as error:
        raise Fail(f"{what}: {error}")
    need(len(out) <= size, f"{what}: inflates past its size")
    need(d.eof and not d.unused_data and not d.unconsumed_tail, f"{what}: not one whole raw DEFLATE stream")
    return out


def read_zip(blob):
    need(len(blob) >= 22, "too short for a ZIP")
    end = len(blob) - 22
    sig, disk, cd_disk, here, total, cd_size, cd_offset, comment = struct.unpack("<IHHHHIIH", blob[end:])
    need(sig == 0x06054B50, "no end record at the end (a comment or trailing bytes)")
    need(disk == 0 and cd_disk == 0, "end record: disk numbers")
    need(here == total, "end record: entry counts differ")
    need(comment == 0, "end record: a comment")
    need(total < CAPS["entries"], "65,535 entries or more")
    need(cd_offset + cd_size == end, "end record: the central directory's size or offset")
    entries, at = [], cd_offset
    for i in range(total):
        need(blob[at:at + 4] == b"PK\x01\x02", f"central record {i}: signature")
        (made, needed, flags, method, time, date, crc, csize, usize, nlen, xlen, clen, dstart, iattr,
         eattr, loff) = struct.unpack("<HHHHHHIIIHHHHHII", blob[at + 4:at + 46])
        name_bytes = blob[at + 46:at + 46 + nlen]
        need(made == 0x14 and needed == 0x14, f"central record {i}: versions")
        need(flags == 0x0800, f"central record {i}: flags {flags:#06x}")
        need(xlen == 0 and clen == 0, f"central record {i}: an extra field or comment")
        need(dstart == 0 and iattr == 0 and eattr == 0, f"central record {i}: disk or attributes")
        need(max(csize, usize, loff) < 0xFFFFFFFF, f"central record {i}: a ZIP64 value")
        entries.append(dict(name_bytes=name_bytes, method=method, time=time, date=date, crc=crc,
                            csize=csize, usize=usize, offset=loff))
        at += 46 + nlen
    need(at == end, "central directory: bytes after the last record")

    offset, seen = 0, set()
    for e in entries:
        name = e["name_bytes"].decode("ascii", errors="replace")
        need(re.fullmatch(r"[\x21-\x7e]+", name) is not None, f"{name!r}: not an ASCII name")
        need(not name.startswith("/") and ".." not in name.split("/") and not name.endswith("/"),
             f"{name}: not a relative file name")
        need(name not in seen, f"{name}: twice")
        seen.add(name)
        e["name"] = name
        need(e["offset"] == offset, f"{name}: not where the previous entry ends")
        local = blob[offset:offset + 30]
        need(local[:4] == b"PK\x03\x04", f"{name}: local signature")
        needed, flags, method, time, date, crc, csize, usize, nlen, xlen = struct.unpack("<HHHHHIIIHH", local[4:30])
        need((needed, flags, method, time, date, crc, csize, usize) ==
             (0x14, 0x0800, e["method"], e["time"], e["date"], e["crc"], e["csize"], e["usize"]),
             f"{name}: local header differs from the central directory")
        need(xlen == 0 and blob[offset + 30:offset + 30 + nlen] == e["name_bytes"], f"{name}: local name or extra field")
        start = offset + 30 + nlen
        stored = blob[start:start + e["csize"]]
        need(len(stored) == e["csize"], f"{name}: truncated")
        if e["method"] == 0:
            need(e["csize"] == e["usize"], f"{name}: stored and declared sizes differ")
            data = stored
        else:
            need(e["method"] == 8, f"{name}: method {e['method']}")
            need(e["csize"] <= 2 * e["usize"] + 1024, f"{name}: stored size past the cap")
            data = inflate_strict(stored, e["usize"], name)
            need(len(data) == e["usize"], f"{name}: inflates short of its size")
        need(zlib.crc32(data) & 0xFFFFFFFF == e["crc"], f"{name}: CRC")
        e["data"] = data
        offset = start + e["csize"]
    need(offset == cd_offset, "data between the last entry and the central directory")
    return entries


# The file

def media_form(form, what, prefix, entries_by_name):
    need(isinstance(form, dict), f"{what}: not an object")
    if "file" in form:
        keys_within(form, ["file", "filename", "type", "sha256", "size"], what)
        need(is_str(form["file"]) and form["file"].startswith(prefix) and form["file"] != prefix, f"{what}.file: outside {prefix}")
        need(isinstance(form.get("sha256"), str) and HEX32.fullmatch(form["sha256"]), f"{what}.sha256")
        entry = entries_by_name.get(form["file"])
        need(entry is not None, f"{what}.file: no entry {form['file']}")
        need(len(entry["data"]) <= CAPS["media"], f"{what}: over the media cap")
        need(num_is(form.get("size"), len(entry["data"])), f"{what}.size: not the entry's size")
        need(hashlib.sha256(entry["data"]).hexdigest() == form["sha256"], f"{what}.sha256: not the entry's")
    else:
        keys_within(form, ["filename", "type", "hash", "size"], what)
        need(is_hash(form.get("hash")), f"{what}.hash")
        need(is_uint(form.get("size")), f"{what}.size")
    need(is_str(form.get("type")), f"{what}.type")
    if "filename" in form:
        need(is_str(form["filename"]) and form["filename"] != "", f"{what}.filename: empty")
    return form.get("file")


# Stable description carriers are structural; native operation payloads are opaque.
OP_BYTES = 256 * 1024
CONTEXT_BYTES = 128 * 1024
# The limits of an `x` (docs/format-versioning.md), the same on every carrier: its own byte
# size and its own nesting depth counted from the `x` itself (the object is level 0). No host cap
# (a step's depth and bytes, the recovery context's budget) counts what is in an `x`.
EXT_BYTES = OP_BYTES
EXT_DEPTH = 32


def finite_wire_json(value, path, max_bytes=OP_BYTES, max_depth=16):
    def visit(v, depth):
        need(depth <= max_depth, f"{path}: description depth")
        if isinstance(v, str):
            need(SURROGATE.search(v) is None, f"{path}: invalid Unicode")
        elif v is None or isinstance(v, bool):
            return
        elif isinstance(v, (int, float)):
            try:
                finite = math.isfinite(float(v))
            except OverflowError:
                finite = False
            need(finite, f"{path}: nonfinite number")
        elif isinstance(v, list):
            for item in v:
                visit(item, depth + 1)
        elif isinstance(v, dict):
            for key, item in v.items():
                need(isinstance(key, str) and SURROGATE.search(key) is None, f"{path}: invalid key")
                visit(item, depth + 1)
        else:
            raise Fail(f"{path}: not JSON")
    visit(value, 0)
    need(len(js_json(value).encode("utf-8")) <= max_bytes, f"{path}: description bytes")


# The keys of each carrier: `x` is ignorable on every one, and what is in it is never read.
STEP_KEYS = ("kind", "operation", "x", "recoveryContext")
ITEM_KEYS = ("kind", "operation", "x")
CONTEXT_KEYS = ("head", "headIndex", "dropped", "omitted", "x")


def extension_form(value, path):
    """An `x`, when present, is a JSON object within the extension byte and depth limits (the one rule)."""
    if "x" in value:
        need(isinstance(value["x"], dict), f"{path}.x: not an object")
        finite_wire_json(value["x"], f"{path}.x", EXT_BYTES, EXT_DEPTH)


def no_x(value):
    """An item without its `x`, which no host cap counts."""
    if isinstance(value, dict) and "x" in value:
        return {k: v for k, v in value.items() if k != "x"}
    return value


def context_no_x(value):
    """A recovery context without the `x` of itself, its head and its dropped items."""
    value = no_x(value)
    if not isinstance(value, dict):
        return value
    value = dict(value)
    if "head" in value:
        value["head"] = no_x(value["head"])
    if isinstance(value.get("dropped"), list):
        value["dropped"] = [no_x(item) for item in value["dropped"]]
    return value


def step_no_x(value):
    """A step without every `x` in it."""
    value = no_x(value)
    if isinstance(value, dict) and "recoveryContext" in value:
        value = dict(value)
        value["recoveryContext"] = context_no_x(value["recoveryContext"])
    return value


def strip_keys(value, keys, path, unknown):
    """A copy of an object without the keys no carrier of v1 has; those go in `unknown` (newer content)."""
    if not isinstance(value, dict):
        return value
    kept = {}
    for key, item in value.items():
        if key in keys:
            kept[key] = item
        else:
            unknown.append(f"{path}{key}")
    return kept


def strip_context(value, path, unknown):
    kept = strip_keys(value, CONTEXT_KEYS, path, unknown)
    if not isinstance(kept, dict):
        return kept
    kept = dict(kept)
    if "head" in kept:
        kept["head"] = strip_keys(kept["head"], ITEM_KEYS, f"{path}head.", unknown)
    if isinstance(kept.get("dropped"), list):
        kept["dropped"] = [strip_keys(item, ITEM_KEYS, f"{path}dropped[{i}].", unknown) for i, item in enumerate(kept["dropped"])]
    return kept


def strip_step(value, path, unknown):
    kept = strip_keys(value, STEP_KEYS, path, unknown)
    if isinstance(kept, dict) and "recoveryContext" in kept:
        kept = dict(kept)
        kept["recoveryContext"] = strip_context(kept["recoveryContext"], f"{path}recoveryContext.", unknown)
    return kept


def strip_entry(e, unknown):
    """An entry for its description check: the keys of its step and recovery context no carrier has removed."""
    kept = dict(e)
    if "step" in e:
        kept["step"] = strip_step(e["step"], "step.", unknown)
    if "recoveryContext" in e:
        kept["recoveryContext"] = strip_context(e["recoveryContext"], "recoveryContext.", unknown)
    return kept


def step_description(value, path):
    need(isinstance(value, dict) and set(value) <= set(ITEM_KEYS) and "kind" in value and "operation" in value, f"{path}: step keys")
    need(value["kind"] in ("init", "edit", "restore"), f"{path}.kind")
    extension_form(value, path)
    finite_wire_json(value["operation"], f"{path}.operation")


def recovery_context(value, path):
    finite_wire_json(context_no_x(value), path, OP_BYTES + CONTEXT_BYTES + 2048, 19)
    need(isinstance(value, dict) and set(value) <= set(CONTEXT_KEYS)
         and {"head", "headIndex", "dropped", "omitted"} <= set(value), f"{path}: context keys")
    extension_form(value, path)
    step_description(value["head"], f"{path}.head")
    dropped = value["dropped"]
    need(isinstance(dropped, list) and len(dropped) <= 64, f"{path}.dropped")
    need(is_uint(value["headIndex"]) and value["headIndex"] <= len(dropped), f"{path}.headIndex")
    need(is_uint(value["omitted"]) and value["omitted"] <= SAFE - len(dropped), f"{path}.omitted")
    for i, item in enumerate(dropped):
        step_description(item, f"{path}.dropped[{i}]")
    need(len(js_json([no_x(item) for item in dropped]).encode("utf-8")) <= CONTEXT_BYTES, f"{path}: optional context bytes")


def step_form(value, path):
    finite_wire_json(step_no_x(value), path, 2 * OP_BYTES + CONTEXT_BYTES + 4096, 20)
    need(isinstance(value, dict), f"{path}: step object")
    need(set(value) <= set(STEP_KEYS) and "kind" in value and "operation" in value, f"{path}: step keys")
    extension_form(value, path)
    step_description({"kind": value.get("kind"), "operation": value.get("operation")}, path)
    if "recoveryContext" in value:
        recovery_context(value["recoveryContext"], f"{path}.recoveryContext")


def entry_description(e, path):
    kind = e.get("kind")
    if kind in ("edit", "restore", "undo", "redo"):
        need("step" in e and "operation" not in e and "recoveryContext" not in e, f"{path}: step carrier")
        step_form(e["step"], f"{path}.step")
        need(e["step"]["kind"] == kind if kind in ("edit", "restore") else e["step"]["kind"] != "init", f"{path}: crossed step kind")
    else:
        need(kind in ("init", "continue", "save", "export", "recovered"), f"{path}.kind")
        need("operation" in e and "step" not in e, f"{path}: event carrier")
        finite_wire_json(e["operation"], f"{path}.operation")
        if kind == "recovered":
            need("recoveryContext" in e, f"{path}: missing recovery context")
            recovery_context(e["recoveryContext"], f"{path}.recoveryContext")
        else:
            need("recoveryContext" not in e, f"{path}: unexpected recovery context")


def entry_form(e, path):
    need(isinstance(e, dict), f"{path}: not an object")
    keys_within(e, ["kind", "time", "operation", "step", "recoveryContext", "snapshot", "noteCount", "dirty", "kept", "revisionId",
                    "device", "appVersion", "stack", "x"], path)
    need(e.get("kind") in ENTRY_KINDS, f"{path}.kind")
    need(is_uint(e.get("time")), f"{path}.time: not a safe integer of at least 0")
    entry_description(e, path)
    need(is_hash(e.get("snapshot")), f"{path}.snapshot")
    # Optional: absent is an unknown count, never 0.
    need("noteCount" not in e or is_uint(e["noteCount"]), f"{path}.noteCount")
    need(e.get("dirty", True) is True, f"{path}.dirty: only true")
    need(e.get("kept", False) is False, f"{path}.kept: only false")
    if e["kind"] == "save":
        need(is_str(e.get("revisionId")), f"{path}.revisionId")
        d = e.get("device")
        keys_within(d, ["id", "label"], f"{path}.device")
        need(is_str(d.get("id")) and is_str(d.get("label")), f"{path}.device")
        # A v1 writer always records the app version of a save (optional only on read).
        need(is_str(e.get("appVersion")) and e["appVersion"] != "", f"{path}.appVersion")
    else:
        need("revisionId" not in e and "device" not in e and "appVersion" not in e,
             f"{path}: revisionId, device or appVersion off a save")
    if e["kind"] == "recovered":
        s = e.get("stack")
        keys_within(s, ["keep", "push", "index", "x"], f"{path}.stack")
        need(is_uint(s.get("keep")) and is_uint(s.get("index")) and isinstance(s.get("push"), list), f"{path}.stack")
        extension_form(s, f"{path}.stack")
        for i, slot in enumerate(s["push"]):
            slot_form(slot, f"{path}.stack.push[{i}]")
    else:
        need("stack" not in e, f"{path}: stack off a recovered entry")
    extension_form(e, path)


def slot_form(slot, path):
    keys_within(slot, ["snapshot", "step", "x"], path)
    need(is_hash(slot.get("snapshot")), path)
    extension_form(slot, path)
    step_form(slot.get("step"), f"{path}.step")


def canonical(value):
    return js_json(value).encode("utf-8")


def hash16(data):
    return hashlib.sha256(data).hexdigest()[:32]


def js_round(x):
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def ieee_div(a, b):
    """a / b as IEEE f64 (JS and Rust): ±inf or nan for a zero divisor, inf on overflow."""
    if b == 0:
        return math.nan if a == 0 or math.isnan(a) else math.copysign(math.inf, a) * math.copysign(1, b)
    try:
        return a / b
    except OverflowError:
        return math.copysign(math.inf, a) * math.copysign(1, b)


def ieee_mul(a, b):
    try:
        return a * b
    except OverflowError:
        return math.copysign(math.inf, a) * math.copysign(1, b)


def duration_ms(slides, bpms):
    beats = [float(note[2]) for slide in slides for note in slide]
    if not beats:
        return 0
    last, time = max(beats), 0.0
    for i, bpm in enumerate(bpms):
        start = 0.0 if i == 0 else float(bpm[0])
        end = float(bpms[i + 1][0]) if i + 1 < len(bpms) else math.inf
        if last <= start:
            break
        time += ieee_div(ieee_mul(min(last, end) - start, 60000.0), float(bpm[1]))
    if not math.isfinite(time):
        return 0
    result = js_round(time)
    return result if 0 < result <= SAFE else 0


def history_total(entries):
    """The manifest and segments together, from their declared sizes (the history cap)."""
    return sum(e["usize"] for e in entries if not e["dir"] and
               (e["key"].startswith("history/segments/") or e["key"] == "history/manifest.json"))


def check_file(path):
    with open(path, "rb") as f:
        blob = f.read()
    try:
        declared = read_directory(blob)
    except (ZipBad, struct.error):
        declared = []
    need(history_total(declared) <= CAPS["history"], "history: the manifest and segments are over their cap together")
    entries = read_zip(blob)
    by_name = {e["name"]: e for e in entries}
    names = [e["name"] for e in entries]
    need(names[:2] == ["project.json", "level.json"], "project.json and level.json first")

    project = parse_json(by_name["project.json"]["data"], "project.json")
    need(len(by_name["project.json"]["data"]) <= CAPS["project"], "project.json: over its cap")
    need(isinstance(project, dict), "project.json: not an object")
    need("parts" not in project, "project.json: parts, which v0.6.0 never writes")
    need(project.get("format") == "nxsp" and num_is(project.get("version"), 1), "project.json: format or version")
    need(is_uint(project.get("minor")) and num_is(project.get("levelVersion"), 1), "project.json: minor or levelVersion")
    need("patch" in project and is_uint(project["patch"]), "project.json: patch")
    for key in ("appVersion", "id", "lineageId"):
        need(is_str(project.get(key)) and project[key] != "", f"project.json.{key}")
    for key in ("name", "exportName"):
        need(key not in project or is_str(project[key]), f"project.json.{key}")
    need(project.get("level") == "level.json", "project.json.level")

    rev = project.get("revision")
    keys_within(rev, ["id", "parent", "n", "savedAt", "device", "ancestors", "replaces", "fileName", "completeFrom"], "revision")
    need(is_str(rev.get("id")) and rev["id"] != "", "revision.id")
    need("parent" in rev and (rev["parent"] is None or (is_str(rev["parent"]) and rev["parent"] != "")), "revision.parent")
    need(is_uint(rev.get("n")), "revision.n")
    keys_within(rev.get("device"), ["id", "label"], "revision.device")
    need(is_str(rev["device"].get("id")) and rev["device"]["id"] != "" and is_str(rev["device"].get("label")),
         "revision.device")
    ancestors = rev.get("ancestors")
    need(isinstance(ancestors, list) and all(is_str(a) and a != "" for a in ancestors) and len(ancestors) <= 1024,
         "revision.ancestors")
    for key in ("replaces", "fileName"):
        need(key not in rev or is_str(rev[key]), f"revision.{key}")
    dos_time, dos_date = dos_of(rev.get("savedAt", ""))
    for e in entries:
        need((e["time"], e["date"]) == (dos_time, dos_date), f"{e['name']}: DOS time is not revision.savedAt's")

    editor = project.get("editor")
    keys_within(editor, ["defaultGuideColors"], "editor")
    if "defaultGuideColors" in editor:
        g = editor["defaultGuideColors"]
        need(isinstance(g, list) and g and all(is_uint(x) for x in g), "editor.defaultGuideColors")

    pointers = {"level.json": "level"}

    def point(name, what):
        need(name not in pointers, f"{what}: names the entry {pointers.get(name)} names")
        pointers[name] = what

    if "bgm" in project:
        f = media_form(project["bgm"], "bgm", "bgm/", by_name)
        if f:
            point(f, "bgm.file")

    meta = project.get("metadata", {})
    need(isinstance(meta, dict) and ("metadata" not in project or meta), "metadata: empty or not an object")
    for key in ("title", "artists", "author", "description"):
        need(key not in meta or (is_str(meta[key]) and meta[key] != ""), f"metadata.{key}")
    need("rating" not in meta or is_number(meta["rating"]), "metadata.rating")
    if "tags" in meta:
        need(isinstance(meta["tags"], list) and meta["tags"], "metadata.tags: empty or not an array")
        for i, tag in enumerate(meta["tags"]):
            keys_within(tag, ["title", "icon"], f"metadata.tags[{i}]")
            need(is_str(tag.get("title")) and is_str(tag.get("icon", "")), f"metadata.tags[{i}]")
    for kind in ("cover", "preview"):
        if kind in meta:
            f = media_form(meta[kind], f"metadata.{kind}", f"assets/{kind}.", by_name)
            if f:
                point(f, f"metadata.{kind}.file")

    level = parse_json(by_name["level.json"]["data"], "level.json")
    need(len(by_name["level.json"]["data"]) <= CAPS["level"], "level.json: over its cap")
    keys_within(level, ["bgmOffset", "entities"], "level.json")

    summary = project.get("summary")
    keys_within(summary, ["noteCount", "durationMs", "revisionId"], "summary")
    need(summary.get("revisionId") == rev["id"], "summary.revisionId: not revision.id")
    need(is_uint(summary.get("noteCount")) and is_uint(summary.get("durationMs")), "summary")

    info = {"path": path, "revision": rev["id"], "ancestors": set(ancestors), "rows": None}
    history = project.get("history")
    carriers = set()
    if history is None:
        need("completeFrom" not in rev, "revision.completeFrom without history")
    else:
        need(rev.get("completeFrom") == rev["id"] or rev.get("completeFrom") in ancestors,
             "revision.completeFrom: cannot be placed")
        keys_within(history, ["manifest", "chunks", "entries", "segments"], "history")
        segments = history.get("segments", [])
        need(isinstance(segments, list) and ("segments" not in history or segments), "history.segments")
        need(len(segments) <= CAPS["segments"], "history.segments: past the cap")
        for i, name in enumerate(segments):
            need(name == f"history/segments/{i + 1}.json", f"history.segments[{i}]: {name}")
            point(name, f"history.segments[{i}]")
        need(history.get("manifest") == "history/manifest.json", "history.manifest")
        need(history.get("chunks") == "history/chunks.bin", "history.chunks")
        point(history["manifest"], "history.manifest")
        point(history["chunks"], "history.chunks")
        info["rows"] = check_history(project, history, segments, by_name, summary, rev, carriers)
        info["completeFrom"] = rev["completeFrom"]

    # `minor` and `patch` are the lowest the content needs, by the pinned tables (the writer's `minorOf`
    # and `patchOf`): not just numbers this build can read.
    need(project["minor"] == expected_minor(history is not None), f"project.json: minor {project['minor']} is not the lowest the content needs")
    need(project["patch"] == expected_patch(carriers), f"project.json: patch {project['patch']} is not the lowest the content needs")

    # Every entry but project.json is named by a pointer, and every pointer names an entry.
    for name in names[1:]:
        need(name in pointers, f"{name}: no pointer names it")
    for name, what in pointers.items():
        need(name in by_name, f"{what}: no entry {name}")
    order = ["project.json", "level.json"] + history_order(history) + \
        [n for n in names if n.startswith("assets/cover.")] + \
        [n for n in names if n.startswith("assets/preview.")] + [n for n in names if n.startswith("bgm/")]
    need(names == order, f"entry order {names}")
    for e in entries:
        expected = (0, 8) if e["name"].startswith(EITHER_PREFIXES) else (0,) if e["name"].startswith(STORE_PREFIXES) else (8,)
        need(e["method"] in expected, f"{e['name']}: method {e['method']}")
    # What it writes, a reader opens fully.
    kind, opened, report = read_nxsp(blob)
    need(kind == "nxsp" and opened == "full", f"the reader opens it {opened or kind}: {report}")
    return info


# `MINOR_TABLE` and `PATCH_TABLE` of src/local/nxsp/version.ts for v1, which this checker pins itself: the
# only manifest `version` is 1, and every thing a file can use (level version 1, root v 1, each entry kind,
# each ZIP entry kind) maps to minor 0. Every `x` carrier row is 0, since no writer writes one.
MINOR_BY_MANIFEST_VERSION = {1: 0}
CARRIER_PATCH = {"entry.x": 0, "step.x": 0, "context.x": 0, "item.x": 0, "slot.x": 0, "stack.x": 0,
                 "undoStack.x": 0, "part.x": 0}


def expected_minor(has_history):
    return MINOR_BY_MANIFEST_VERSION[1] if has_history else 0


def expected_patch(carriers):
    return max([CARRIER_PATCH[c] for c in carriers] + [0])


def carriers_in(part, found):
    """The `x` carriers a part holds, by the names of CARRIER_PATCH (the editor's carriersIn)."""
    def context(c):
        if not isinstance(c, dict):
            return
        if "x" in c:
            found.add("context.x")
        dropped = c.get("dropped")
        for item in [c.get("head")] + (dropped if isinstance(dropped, list) else []):
            if isinstance(item, dict) and "x" in item:
                found.add("item.x")

    def step(s):
        if isinstance(s, dict):
            if "x" in s:
                found.add("step.x")
            context(s.get("recoveryContext"))

    def slot(s):
        if isinstance(s, dict):
            if "x" in s:
                found.add("slot.x")
            step(s.get("step"))

    if not isinstance(part, dict):
        return
    if "x" in part:
        found.add("part.x")
    for e in part.get("entries") if isinstance(part.get("entries"), list) else []:
        if not isinstance(e, dict):
            continue
        if "x" in e:
            found.add("entry.x")
        step(e.get("step"))
        context(e.get("recoveryContext"))
        stack = e.get("stack")
        if isinstance(stack, dict):
            if "x" in stack:
                found.add("stack.x")
            for s in stack.get("push") if isinstance(stack.get("push"), list) else []:
                slot(s)
    stack = part.get("undoStack")
    if isinstance(stack, dict):
        if "x" in stack:
            found.add("undoStack.x")
        for s in stack.get("slots") if isinstance(stack.get("slots"), list) else []:
            slot(s)


def history_order(history):
    if history is None:
        return []
    return list(history.get("segments", [])) + ["history/manifest.json", "history/chunks.bin"]


def check_history(project, history, segments, by_name, summary, rev, carriers):
    parts = []
    for name in segments:
        need(len(by_name[name]["data"]) <= CAPS["manifest"], f"{name}: over its cap")
        part = parse_json(by_name[name]["data"], name)
        keys_within(part, ["entries", "roots", "nodes", "chunks", "x"], name)
        need({"entries", "roots", "nodes", "chunks"} <= set(part), f"{name}: a key missing")
        extension_form(part, name)
        parts.append((name, part))
    data = by_name["history/manifest.json"]["data"]
    need(len(data) <= CAPS["manifest"], "manifest: over its cap")
    manifest = parse_json(data, "manifest")
    keys_within(manifest, ["version", "entries", "roots", "nodes", "chunks", "undoStack", "x"], "manifest")
    need({"version", "entries", "roots", "nodes", "chunks", "undoStack"} <= set(manifest)
         and num_is(manifest["version"], 1), "manifest: version or a key missing")
    extension_form(manifest, "manifest")
    parts.append(("manifest", manifest))
    for _, part in parts:
        carriers_in(part, carriers)

    chunks_bin = by_name["history/chunks.bin"]["data"]
    need(len(chunks_bin) <= CAPS["chunks"], "chunks.bin: over its cap")
    entries, roots, nodes, index, cursor = [], {}, {}, {}, 0
    for name, part in parts:
        need(isinstance(part["entries"], list), f"{name}.entries")
        for i, e in enumerate(part["entries"]):
            entry_form(e, f"{name}.entries[{i}]")
        entries += part["entries"]
        for kind, target in (("roots", roots), ("nodes", nodes)):
            need(isinstance(part[kind], dict), f"{name}.{kind}")
            for key, value in part[kind].items():
                need(key not in target or js_json(target[key]) == js_json(value), f"{name}.{kind}.{key}: two values")
                target[key] = value
        need(isinstance(part["chunks"], list), f"{name}.chunks")
        for item in part["chunks"]:
            need(isinstance(item, list) and len(item) == 3 and is_hash(item[0]) and is_uint(item[1]) and is_uint(item[2]),
                 f"{name}.chunks: {item}")
            h, off, length = item
            need(h not in index, f"chunk {h}: listed twice")
            need(off == cursor, f"chunk {h}: the index does not tile chunks.bin")
            index[h] = (off, length)
            cursor = off + length
    need(cursor == len(chunks_bin), "chunks.bin: the index does not end at its end")
    need(num_is(history.get("entries"), len(entries)), "history.entries: not the entry count")

    texts = {}
    for h, (off, length) in index.items():
        raw = inflate_strict(chunks_bin[off:off + length], CAPS["chunk"], f"chunk {h}")
        need(hash16(raw) == h, f"chunk {h}: does not hash to its name")
        texts[h] = raw

    kind_order = FIELDS["kindOrder"]
    node_kinds = {}
    for key, node in nodes.items():
        need(is_hash(key), f"nodes.{key}: not a hash")
        check_record("node", node, f"nodes.{key}")
        need(node[1] in (0, 1), f"nodes.{key}: depth")
        need(hash16(canonical(node)) == key, f"nodes.{key}: does not hash to its key")
        node_kinds[key] = (node[0], node[1])

    for key, (kind, depth) in node_kinds.items():
        for child in nodes[key][2]:
            if depth == 0:
                need(child in index, f"nodes.{key}: chunk {child} missing")
            else:
                need(node_kinds.get(child) == (kind, 0), f"nodes.{key}: child {child} missing or invalid")

    parsed, checked = {}, {}

    def chunk_json(h, what):
        need(h in texts, f"{what}: chunk {h} missing")
        if h not in parsed:
            parsed[h] = parse_json(texts[h], f"chunk {h}")
        return parsed[h]

    note_counts = {}
    heads = {}
    for key, root in roots.items():
        need(is_hash(key), f"roots.{key}: not a hash")
        check_record("root", root, f"roots.{key}")
        need(root[0] == 1, f"roots.{key}: v {root[0]}")
        need(hash16(canonical(root)) == key, f"roots.{key}: does not hash to its key")
        positions = [kind_order.index(name) for name, _ in root[2]]
        need(positions == sorted(set(positions)), f"roots.{key}: kinds out of the v1 order")
        header = chunk_json(root[1], f"roots.{key}")
        check_record("header", header, f"roots.{key}.header")
        ids = check_header_refs(header, f"roots.{key}.header")
        notes, kinds = 0, {}
        for name, top in root[2]:
            need(node_kinds.get(top, (None,))[0] == name, f"roots.{key}: node {top} missing or of another kind")
            kind, depth = node_kinds[top]
            children = nodes[top][2]
            if depth == 1:
                leaves = []
                for child in children:
                    need(node_kinds.get(child) == (kind, 0), f"nodes.{top}: child {child} missing or invalid")
                    leaves += nodes[child][2]
                children = leaves
            records = []
            form = FIELDS["kinds"][name]
            for h in children:
                chunk = chunk_json(h, f"nodes.{top}")
                need(isinstance(chunk, list), f"chunk {h}: not an array")
                # A chunk's references are checked against each header that reaches it.
                header_key = (h, form, root[1])
                if header_key not in checked:
                    for i, record in enumerate(chunk):
                        check_record(form, record, f"chunk {h}[{i}]")
                        check_refs(form, record, ids, f"chunk {h}[{i}]")
                    checked[header_key] = True
                records += chunk
            kinds[name] = records
            if name == "slides":
                notes = sum(len(slide) for slide in records)
        need(notes == root[3], f"roots.{key}: noteCount {root[3]}, but {notes} notes")
        note_counts[key] = notes
        heads[key] = kinds

    def held(h, what):
        need(h in roots, f"{what}: root {h} missing")

    for i, e in enumerate(entries):
        if e.get("kept") is False:
            continue
        held(e["snapshot"], f"entries[{i}]")
        for j, slot in enumerate(e.get("stack", {}).get("push", [])):
            held(slot["snapshot"], f"entries[{i}].stack.push[{j}]")
    stack = manifest["undoStack"]
    keys_within(stack, ["base", "slots", "index", "x"], "undoStack")
    need(is_uint(stack.get("base")) and is_uint(stack.get("index")) and isinstance(stack.get("slots"), list), "undoStack")
    extension_form(stack, "undoStack")
    for i, slot in enumerate(stack["slots"]):
        slot_form(slot, f"undoStack.slots[{i}]")
        held(slot["snapshot"], f"undoStack.slots[{i}]")
    need(stack["base"] <= stack["index"] < stack["base"] + len(stack["slots"]), "undoStack.index: out of range")

    last = entries[-1] if entries else {}
    need(last.get("kind") == "save" and last.get("revisionId") == rev["id"] and last.get("device") == rev["device"],
         "the chronology does not end with this revision's save entry")
    head = stack["slots"][stack["index"] - stack["base"]]["snapshot"]
    need(summary["noteCount"] == note_counts[head], "summary.noteCount: not the head's")
    kinds = heads[head]
    need(summary["durationMs"] == duration_ms(kinds.get("slides", []), kinds.get("bpms", [])),
         "summary.durationMs: not the head's")

    rows = {}
    for e in entries:
        if e["snapshot"] in roots:
            row = (e["kind"], e["time"], e["snapshot"])
            rows[row] = rows.get(row, 0) + 1
    return rows


def check_complete_from(infos):
    """A file's `completeFrom` against every given file between that revision and it."""
    for n in infos:
        if n["rows"] is None:
            continue
        r = n["completeFrom"]
        for f in infos:
            if f is n or f["rows"] is None or f["revision"] not in n["ancestors"]:
                continue
            if f["revision"] != r and r not in f["ancestors"]:
                continue
            for row, count in f["rows"].items():
                need(n["rows"].get(row, 0) >= count,
                     f"{n['path']}: completeFrom {r} claims {f['path']}'s row {row}, which it lacks")


def show(path, target):
    with open(path, "rb") as f:
        entries = {e["name"]: e for e in read_zip(f.read())}
    project = json.loads(entries["project.json"]["data"])
    history = project["history"]
    roots, nodes, index = {}, {}, {}
    for name in list(history.get("segments", [])) + [history["manifest"]]:
        part = json.loads(entries[name]["data"])
        roots.update(part["roots"])
        nodes.update(part["nodes"])
        index.update({h: (o, n) for h, o, n in part["chunks"]})

    def named(form, value):
        fields = FIELDS[form]
        if isinstance(fields, dict):
            return [named(fields["type"][6:], x) for x in value]
        out = {}
        for field, x in zip(fields, value):
            t = field["type"]
            if t.startswith("record:"):
                x = named(t[7:], x)
            elif t.startswith("array:") and t[6:] in FIELDS:
                x = [named(t[6:], y) for y in x]
            elif t == "mediaRefOrEmpty" and x:
                x = named("mediaRef", x)
            out[field["name"]] = x
        return out

    if target in roots:
        print(json.dumps(named("root", roots[target]), indent=2, ensure_ascii=False))
    elif target in nodes:
        print(json.dumps(named("node", nodes[target]), indent=2, ensure_ascii=False))
    elif target in index:
        off, length = index[target]
        value = json.loads(zlib.decompress(entries["history/chunks.bin"]["data"][off:off + length], -15))
        headers = {r[1] for r in roots.values()}
        if target in headers:
            print(json.dumps(named("header", value), indent=2, ensure_ascii=False))
        else:
            kind = next(n[0] for n in nodes.values() if n[1] == 0 and target in n[2])
            print(json.dumps([named(FIELDS["kinds"][kind], r) for r in value], indent=2, ensure_ascii=False))
    else:
        raise Fail(f"no root, node or chunk {target}")


# Reader mode (--read): what a v1 reader opens, for files a writer
# doesn't make (an OS re-zip, a partial file). It reports as the editor's reader does: `full`, or
# `partial` with its reasons, `unreadable`, or `not-project`, checking only what an open checks.

class ZipBad(Exception):
    pass


class ZipLimit(ZipBad):
    pass


SENTINEL = 0xFFFFFFFF
END_TAIL = 0xFFFF + 22 + 20
ISSUE_CAP = 20
IGNORED_NAMES = (".DS_Store", "Thumbs.db", "desktop.ini")


def decode_name(raw, flags):
    if flags & 0x0800:
        text = raw.decode("utf-8", errors="replace")
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("cp437")
    return text


def u16(b, at):
    return struct.unpack_from("<H", b, at)[0]


def u32(b, at):
    return struct.unpack_from("<I", b, at)[0]


def u64(b, at):
    v = struct.unpack_from("<Q", b, at)[0]
    if v > SAFE:
        raise ZipBad("size")
    return v


def find_extra(extra, ident):
    p = 0
    while p + 4 <= len(extra):
        length = u16(extra, p + 2)
        if p + 4 + length > len(extra):
            return None
        if u16(extra, p) == ident:
            return extra[p + 4:p + 4 + length]
        p += 4 + length
    return None


def entry_of(name_raw, flags, method, crc, csize, usize, offset, index):
    name = decode_name(name_raw, flags)
    return dict(index=index, raw=name_raw, name=name, key=unicodedata.normalize("NFC", name), flags=flags,
                method=method, crc=crc, csize=csize, usize=usize, offset=offset, dir=name.endswith("/"))


def least_end(e):
    return e["offset"] + 30 + len(e["raw"]) + e["csize"]


def find_end(blob):
    start = max(0, len(blob) - END_TAIL)
    tail = blob[start:]
    loose = -1
    for i in range(len(tail) - 22, -1, -1):
        if u32(tail, i) != 0x06054B50:
            continue
        rest = len(tail) - (i + 22)
        comment = u16(tail, i + 20)
        if comment == rest:
            return read_end(tail, i)
        if comment < rest and loose < 0:
            loose = i
    if loose < 0:
        raise ZipBad("no end record")
    return read_end(tail, loose)


def read_end(tail, at):
    count, cd_size, cd_offset = u16(tail, at + 10), u32(tail, at + 12), u32(tail, at + 16)
    if count != 0xFFFF and cd_size != SENTINEL and cd_offset != SENTINEL:
        return count, cd_size, cd_offset, None
    if at < 20 or u32(tail, at - 20) != 0x07064B50:
        raise ZipBad("ZIP64 locator")
    return count, cd_size, cd_offset, u64(tail, at - 20 + 8)


def read_directory(blob):
    count, cd_size, cd_offset, zip64 = find_end(blob)
    if zip64 is not None:
        rec = blob[zip64:zip64 + 56]
        if len(rec) < 56 or u32(rec, 0) != 0x06064B50:
            raise ZipBad("ZIP64 end")
        count, cd_size, cd_offset = u64(rec, 32), u64(rec, 40), u64(rec, 48)
    if count > 0xFFFF:
        raise ZipLimit("entries")
    cd_end = cd_offset + cd_size
    if cd_end > len(blob) or count * 46 > cd_size:
        raise ZipBad("central directory")
    entries, at = [], cd_offset
    for index in range(count):
        if at + 46 > cd_end or u32(blob, at) != 0x02014B50:
            raise ZipBad("central directory")
        nlen, xlen, clen = u16(blob, at + 28), u16(blob, at + 30), u16(blob, at + 32)
        nxt = at + 46 + nlen + xlen + clen
        if nxt > cd_end:
            raise ZipBad("central directory")
        flags, method, crc = u16(blob, at + 8), u16(blob, at + 10), u32(blob, at + 16)
        csize, usize, offset = u32(blob, at + 20), u32(blob, at + 24), u32(blob, at + 42)
        if SENTINEL in (usize, csize, offset):
            field = find_extra(blob[at + 46 + nlen:at + 46 + nlen + xlen], 1)
            if field is None:
                raise ZipBad("ZIP64 extra")
            p = 0
            values = []
            for v in (usize, csize, offset):
                if v == SENTINEL:
                    if p + 8 > len(field):
                        raise ZipBad("ZIP64 extra")
                    values.append(u64(field, p))
                    p += 8
                else:
                    values.append(v)
            usize, csize, offset = values
        e = entry_of(bytes(blob[at + 46:at + 46 + nlen]), flags, method, crc, csize, usize, offset, index)
        if least_end(e) > len(blob):
            raise ZipBad("truncated")
        entries.append(e)
        at = nxt
    return entries


def local_header(blob, at):
    fixed = blob[at:at + 30]
    if len(fixed) < 30:
        raise ZipBad("truncated")
    if u32(fixed, 0) != 0x04034B50:
        raise ZipBad("local header")
    nlen, xlen = u16(fixed, 26), u16(fixed, 28)
    total = 30 + nlen + xlen
    if at + total > len(blob):
        raise ZipBad("truncated")
    csize, usize = u32(fixed, 18), u32(fixed, 22)
    if SENTINEL in (csize, usize):
        field = find_extra(blob[at + 30 + nlen:at + total], 1)
        if field is not None and len(field) >= 16:
            if usize == SENTINEL:
                usize = u64(field, 0)
            if csize == SENTINEL:
                csize = u64(field, 8)
    return dict(flags=u16(fixed, 6), method=u16(fixed, 8), crc=u32(fixed, 14), csize=csize, usize=usize,
                raw=bytes(blob[at + 30:at + 30 + nlen]), total=total)


def scan_local(blob):
    entries, at = [], 0
    while at + 30 <= len(blob):
        if u32(blob, at) != 0x04034B50:
            break
        h = local_header(blob, at) if at + 30 + u16(blob, at + 26) + u16(blob, at + 28) <= len(blob) else None
        if h is None:
            break
        if h["flags"] & 8 and h["csize"] == 0:
            break
        nxt = at + h["total"] + h["csize"]
        if nxt > len(blob):
            break
        if len(entries) == 0xFFFF:
            raise ZipLimit("entries")
        entries.append(entry_of(h["raw"], h["flags"], h["method"], h["crc"], h["csize"], h["usize"], at, len(entries)))
        if h["flags"] & 8:
            d = blob[nxt:nxt + 24]
            signed = 4 if len(d) >= 4 and u32(d, 0) == 0x08074B50 else 0
            for wide in (False, True):
                length = signed + (20 if wide else 12)
                if len(d) < length or u32(d, signed) != h["crc"]:
                    continue
                sizes = (struct.unpack_from("<QQ", d, signed + 4) if wide else struct.unpack_from("<II", d, signed + 4))
                if tuple(sizes) == (h["csize"], h["usize"]):
                    nxt += length
                    break
        at = nxt
    if not entries:
        raise ZipBad("not a ZIP")
    return entries


class Zip:
    def __init__(self, blob):
        self.blob = blob
        self.recovered = False
        try:
            self.entries = read_directory(blob)
        except ZipLimit:
            raise
        except (ZipBad, struct.error):
            self.entries = scan_local(blob)
            self.recovered = True
        keys = [e["key"] for e in self.entries]
        self.duplicates = sorted({k for k in keys if keys.count(k) > 1}) if len(keys) != len(set(keys)) else []
        files = sorted((e for e in self.entries if not e["dir"]), key=lambda e: e["offset"])
        self.overlapping = set()
        furthest = None
        for e in files:
            end = least_end(e)
            if furthest and e["offset"] < furthest[1]:
                self.overlapping |= {furthest[0]["key"], e["key"]}
            if not furthest or end > furthest[1]:
                furthest = (e, end)
        # Real ranges: every entry's, from its local header with the extra field.
        self.real_overlapping = set()
        furthest = None
        for e in files:
            if furthest and e["offset"] < furthest[1]:
                self.real_overlapping |= {furthest[0]["key"], e["key"]}
            fixed = blob[e["offset"]:e["offset"] + 30]
            total = 30 + u16(fixed, 26) + u16(fixed, 28) if len(fixed) == 30 and u32(fixed, 0) == 0x04034B50 \
                else 30 + len(e["raw"])
            end = e["offset"] + total + e["csize"]
            if not furthest or end > furthest[1]:
                furthest = (e, end)
        self.ambiguous = set(self.duplicates) | self.overlapping
        self.by_key = {e["key"]: e for e in self.entries if e["key"] not in self.ambiguous}

    def get(self, name):
        return self.by_key.get(unicodedata.normalize("NFC", name))

    def stored(self, e):
        blob = self.blob
        if e["offset"] + 30 > len(blob):
            raise ZipBad("truncated")
        h = local_header(blob, e["offset"])
        if h["raw"] != e["raw"] or h["method"] != e["method"]:
            raise ZipBad("local header")

        def differs(local, central):
            return local != central and (not h["flags"] & 8 or local not in (0, SENTINEL))
        if differs(h["crc"], e["crc"]) or differs(h["csize"], e["csize"]) or differs(h["usize"], e["usize"]):
            raise ZipBad("local header")
        start = e["offset"] + h["total"]
        if start + e["csize"] > len(blob):
            raise ZipBad("truncated")
        if not e["dir"] and e["key"] in self.real_overlapping:
            raise ZipBad("overlapping data")
        return blob[start:start + e["csize"]]

    def read(self, e, cap):
        if e["flags"] & 1 or e["method"] not in (0, 8):
            raise ZipBad("unsupported")
        if e["usize"] > cap:
            raise ZipBad("too large")
        if e["csize"] != e["usize"] if e["method"] == 0 else e["csize"] > 2 * e["usize"] + 1024:
            raise ZipBad("size")
        stored = self.stored(e)
        data = stored if e["method"] == 0 else inflate_exact(stored, e["usize"])
        if zlib.crc32(data) & 0xFFFFFFFF != e["crc"]:
            raise ZipBad("crc")
        return data


def inflate_exact(data, size):
    if size == 0 and not data:
        return b""
    d = zlib.decompressobj(-15)
    try:
        out = d.decompress(data, size + 1)
    except zlib.error:
        raise ZipBad("inflate")
    if len(out) > size or d.unconsumed_tail:
        raise ZipBad("size")
    if not d.eof:
        raise ZipBad("truncated")
    if d.unused_data:
        raise ZipBad("size")
    if len(out) != size:
        raise ZipBad("size")
    return out


def inflate_chunk(data, cap):
    d = zlib.decompressobj(-15)
    try:
        out = d.decompress(data, cap + 1)
    except zlib.error:
        raise ZipBad("inflate")
    if len(out) > cap or d.unconsumed_tail or not d.eof or d.unused_data:
        raise ZipBad("not one whole raw DEFLATE stream")
    return out


class JsonBad(Exception):
    pass


def read_json_text(data, cap_depth=64):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise JsonBad("not UTF-8")
    if text.startswith("﻿"):
        text = text[1:]
    if depth_of(text) > cap_depth:
        raise JsonBad("nested too deep")
    try:
        return json.loads(text, parse_constant=reject_constant)
    except (ValueError, Fail) as error:
        raise JsonBad(str(error))


class ReadFailure(Exception):
    def __init__(self, reason, path):
        super().__init__(path)
        self.item = (reason, path)


def is_safe_int(v):
    return is_int(v) and -SAFE <= v <= SAFE


def is_hex64(v):
    return isinstance(v, str) and HEX32.fullmatch(v) is not None


def is_nonempty(v):
    return isinstance(v, str) and v != ""


PROJECT_KEYS = ["format", "version", "minor", "patch", "levelVersion", "appVersion", "id", "lineageId", "revision",
                "name", "exportName", "level", "editor", "bgm", "history", "summary", "metadata", "parts"]


def read_media_form(value, path, issues):
    if not isinstance(value, dict):
        issues.append(("schema", path))
        return None
    with_file = "file" in value
    allowed = ["file", "filename", "type", "sha256", "size"] if with_file else ["filename", "type", "hash", "size"]
    ok = True
    for key in value:
        if key not in allowed:
            issues.append(("unknown-key", f"{path}.{key}"))
            ok = False
    valid = ((not with_file or is_str(value.get("file"))) and ("filename" not in value or is_str(value["filename"]))
             and is_str(value.get("type")) and is_uint(value.get("size"))
             and (is_hex64(value.get("sha256")) if with_file else is_hash(value.get("hash"))))
    if not valid:
        issues.append(("schema", path))
        ok = False
    return value if ok else None


def read_project(p):
    issues = []
    minor = p.get("minor", 0)
    patch = p.get("patch", 0)
    level_version = p.get("levelVersion")

    def required(ok, path):
        if not ok:
            issues.append(("schema", path))
    required(is_uint(minor), "minor")
    required(is_uint(patch), "patch")
    required(is_safe_int(level_version) and level_version >= 1, "levelVersion")
    required(is_str(p.get("appVersion")), "appVersion")
    required(is_nonempty(p.get("id")), "id")
    required(is_nonempty(p.get("lineageId")), "lineageId")
    required("name" not in p or is_str(p["name"]), "name")
    required("exportName" not in p or is_str(p["exportName"]), "exportName")
    required(is_str(p.get("level")), "level")

    rev = p.get("revision")
    if "revision" in p:
        d = rev.get("device") if isinstance(rev, dict) else None
        valid = (isinstance(rev, dict) and is_nonempty(rev.get("id")) and (rev.get("parent", 0) is None or is_nonempty(rev.get("parent")))
                 and is_uint(rev.get("n")) and isinstance(d, dict)
                 and is_str(d.get("id")) and is_str(d.get("label")) and isinstance(rev.get("ancestors"), list)
                 and all(is_nonempty(a) for a in rev["ancestors"])
                 and ("replaces" not in rev or is_str(rev["replaces"])) and ("fileName" not in rev or is_str(rev["fileName"])))
        if not valid:
            issues.append(("schema", "revision"))
    if "editor" in p:
        editor = p["editor"]
        if not isinstance(editor, dict):
            issues.append(("schema", "editor"))
        else:
            for key in editor:
                if key != "defaultGuideColors":
                    issues.append(("unknown-key", f"editor.{key}"))
            if "defaultGuideColors" in editor:
                g = editor["defaultGuideColors"]
                if not isinstance(g, list) or not all(is_uint(x) for x in g):
                    issues.append(("schema", "editor.defaultGuideColors"))
    bgm = read_media_form(p["bgm"], "bgm", issues) if "bgm" in p else None
    history = None
    if "history" in p:
        h = p["history"]
        if not isinstance(h, dict):
            issues.append(("schema", "history"))
        else:
            ok = True
            for key in h:
                if key not in ("manifest", "chunks", "entries", "segments"):
                    issues.append(("unknown-key", f"history.{key}"))
                    ok = False
            segs = h.get("segments")
            if not (is_str(h.get("manifest")) and is_str(h.get("chunks")) and is_uint(h.get("entries"))
                    and ("segments" not in h or (isinstance(segs, list) and all(is_str(s) for s in segs)))):
                issues.append(("schema", "history"))
            elif isinstance(segs, list) and len(segs) > CAPS["segments"]:
                issues.append(("limit", "history.segments"))
            elif ok:
                history = h
    metadata = {}
    if "metadata" in p:
        meta = p["metadata"]
        if not isinstance(meta, dict):
            issues.append(("schema", "metadata"))
        else:
            for key, item in meta.items():
                path = f"metadata.{key}"
                if key in ("title", "artists", "author", "description"):
                    if not is_str(item):
                        issues.append(("schema", path))
                elif key == "rating":
                    if not is_number(item):
                        issues.append(("schema", path))
                elif key == "tags":
                    if not isinstance(item, list):
                        issues.append(("schema", path))
                        continue
                    for i, tag in enumerate(item):
                        if not isinstance(tag, dict) or not is_str(tag.get("title")) or ("icon" in tag and not is_str(tag["icon"])):
                            issues.append(("schema", f"{path}[{i}]"))
                            continue
                        for name in tag:
                            if name not in ("title", "icon"):
                                issues.append(("unknown-key", f"{path}[{i}].{name}"))
                elif key in ("cover", "preview"):
                    media = read_media_form(item, path, issues)
                    if media is not None:
                        metadata[key] = media
    if "parts" in p:
        parts = p["parts"]
        if not isinstance(parts, dict):
            issues.append(("damaged", "parts"))
        else:
            for key in parts:
                issues.append(("unknown-key", f"parts.{key}"))
    saved_at = parse_saved_at(rev.get("savedAt")) if isinstance(rev, dict) and not any(i == ("schema", "revision") for i in issues) else None
    project = dict(minor=minor if is_uint(minor) else 0, patch=patch if is_uint(patch) else 0, saved_at=saved_at,
                   levelVersion=level_version if is_safe_int(level_version) else 1,
                   level=p["level"] if is_str(p.get("level")) else "", bgm=bgm, history=history, metadata=metadata)
    return project, issues


class Issues:
    def __init__(self):
        self.items, self.more, self.more_reason = [], 0, "damaged"

    def __len__(self):
        return len(self.items) + self.more

    def add(self, reason, path):
        if len(self.items) < ISSUE_CAP:
            self.items.append((reason, path))
        else:
            if self.more == 0:
                self.more_reason = reason
            self.more += 1

    def done(self, path):
        return self.items + ([(self.more_reason, path)] if self.more else [])


ENTRY_KEYS = ["kind", "time", "operation", "step", "recoveryContext", "snapshot", "noteCount", "dirty", "kept", "revisionId", "device",
              "appVersion", "stack", "x"]


def part_extension(value, path, issues):
    """An `x` is valid by the one extension rule, on every carrier."""
    if "x" in value:
        try:
            extension_form(value, path)
        except Fail:
            issues.add("damaged", f"{path}.x")


def part_slot(value, path, issues):
    if not isinstance(value, dict):
        issues.add("damaged", path)
        return
    for key in value:
        if key not in ("snapshot", "step", "x"):
            issues.add("unknown-key", f"{path}.{key}")
    if not is_hash(value.get("snapshot")):
        issues.add("damaged", path)
    part_extension(value, path, issues)
    unknown = []
    step = strip_step(value.get("step"), "", unknown)
    for key in unknown:
        issues.add("unknown-key", f"{path}.step.{key}")
    try:
        step_form(step, f"{path}.step")
    except Fail:
        issues.add("damaged", f"{path}.step")


def part_entry(e, path, issues):
    if not isinstance(e, dict):
        issues.add("damaged", path)
        return
    for key in e:
        if key not in ENTRY_KEYS:
            issues.add("unknown-key", f"{path}.{key}")
    kind = e.get("kind")
    if is_str(kind) and kind not in ENTRY_KINDS:
        issues.add("newer", f"{path}.kind")
        return
    if not is_str(kind):
        issues.add("damaged", f"{path}.kind")

    def fail(key):
        issues.add("damaged", f"{path}.{key}")

    def foreign(key):
        issues.add("unknown-key", f"{path}.{key}")
    if not is_uint(e.get("time")):
        fail("time")
    unknown = []
    described = strip_entry(e, unknown)
    for key in unknown:
        issues.add("unknown-key", f"{path}.{key}")
    try:
        entry_description(described, path)
    except Fail:
        fail("description")
    if not is_hash(e.get("snapshot")):
        fail("snapshot")
    if "noteCount" in e and not is_uint(e["noteCount"]):
        fail("noteCount")
    if "dirty" in e and e["dirty"] is not True:
        fail("dirty")
    if "kept" in e and e["kept"] is not False:
        fail("kept")
    if kind == "save":
        if not is_str(e.get("revisionId")):
            fail("revisionId")
        d = e.get("device")
        if not isinstance(d, dict) or not is_str(d.get("id")) or not is_str(d.get("label")):
            fail("device")
        else:
            for key in d:
                if key not in ("id", "label"):
                    issues.add("unknown-key", f"{path}.device.{key}")
        # Optional on read: a file from a build before the version was recorded still opens.
        if "appVersion" in e and not is_str(e["appVersion"]):
            fail("appVersion")
    else:
        if "revisionId" in e:
            foreign("revisionId")
        if "device" in e:
            foreign("device")
        if "appVersion" in e:
            foreign("appVersion")
    if kind == "recovered":
        s = e.get("stack")
        if not isinstance(s, dict) or not is_uint(s.get("keep")) or not is_uint(s.get("index")) or not isinstance(s.get("push"), list):
            fail("stack")
        else:
            for key in s:
                if key not in ("keep", "push", "index", "x"):
                    issues.add("unknown-key", f"{path}.stack.{key}")
            part_extension(s, f"{path}.stack", issues)
            for i, slot in enumerate(s["push"]):
                part_slot(slot, f"{path}.stack.push[{i}]", issues)
    elif "stack" in e:
        foreign("stack")
    part_extension(e, path, issues)


def check_part(value, path, manifest):
    """The editor's checkPart: (part or None, issues)."""
    if not isinstance(value, dict):
        return None, [("damaged", path)]
    if manifest:
        version = value.get("version")
        if not is_safe_int(version) or version < 1:
            return None, [("damaged", f"{path}.version")]
        if version > 1:
            return None, [("newer", f"{path}.version")]
    issues = Issues()
    allowed = ["entries", "roots", "nodes", "chunks", "x"] + (["version", "undoStack"] if manifest else [])
    for key in value:
        if key not in allowed:
            issues.add("unknown-key", f"{path}.{key}")
    part_extension(value, path, issues)
    entries = value.get("entries")
    if not isinstance(entries, list):
        issues.add("damaged", f"{path}.entries")
    else:
        for i, e in enumerate(entries):
            part_entry(e, f"{path}.entries[{i}]", issues)
    for key in ("roots", "nodes"):
        m = value.get(key)
        if not isinstance(m, dict):
            issues.add("damaged", f"{path}.{key}")
        else:
            for k in m:
                if not is_hash(k):
                    issues.add("damaged", f"{path}.{key}.{k}")
    chunks = value.get("chunks")
    if not isinstance(chunks, list):
        issues.add("damaged", f"{path}.chunks")
    else:
        for i, item in enumerate(chunks):
            if not (isinstance(item, list) and len(item) == 3 and is_hash(item[0]) and is_uint(item[1]) and is_uint(item[2])):
                issues.add("damaged", f"{path}.chunks[{i}]")
    if manifest:
        s = value.get("undoStack")
        if not isinstance(s, dict) or not is_uint(s.get("base")) or not is_uint(s.get("index")) or not isinstance(s.get("slots"), list):
            issues.add("damaged", f"{path}.undoStack")
        else:
            for key in s:
                if key not in ("base", "slots", "index", "x"):
                    issues.add("unknown-key", f"{path}.undoStack.{key}")
            part_extension(s, f"{path}.undoStack", issues)
            for i, slot in enumerate(s["slots"]):
                part_slot(slot, f"{path}.undoStack.slots[{i}]", issues)
    if len(issues):
        return None, issues.done(path)
    return value, []


def known_kind(name):
    return name in FIELDS["kindOrder"]


def check_root_form(root):
    check_record("root", root, "root")
    need(root[0] == 1 and not isinstance(root[0], bool), "root.v")
    last = -1
    for name, _ in root[2]:
        at = FIELDS["kindOrder"].index(name)
        need(at > last, "root.kinds: out of the v1 kind order")
        last = at


def combine_parts(segments, manifest, expected_entries, chunks_size):
    issues = Issues()
    entries, roots, nodes, index, nxt = [], {}, {}, {}, 0
    for p, part in enumerate(segments + [manifest]):
        entries.extend(part["entries"])
        for name, target in (("roots", roots), ("nodes", nodes)):
            for key, value in part[name].items():
                if key in target and js_json(target[key]) != js_json(value):
                    issues.add("damaged", f"{name}.{key}")
                target[key] = value
        for h, off, length in part["chunks"]:
            if h in index:
                issues.add("damaged", f"chunks.{h}")
            if off != nxt:
                issues.add("damaged", f"chunks.{h}")
            index[h] = (off, length)
            nxt = off + length
    if nxt != chunks_size:
        issues.add("damaged", "chunks")
    if len(entries) != expected_entries:
        issues.add("damaged", "history.entries")

    node_kinds = {}
    for key, node in nodes.items():
        try:
            check_record("node", node, "node")
            need(node[1] in (0, 1) and not isinstance(node[1], bool), "node.depth")
            need(hash16(js_json(node).encode("utf-8")) == key, "node: hash")
            node_kinds[key] = (node[0], node[1])
        except Fail:
            if isinstance(node, list) and node and is_str(node[0]) and not known_kind(node[0]):
                issues.add("newer", f"nodes.{key}")
            else:
                issues.add("damaged", f"nodes.{key}")
    for key, (kind, depth) in node_kinds.items():
        for child in nodes[key][2]:
            if depth == 0:
                if child not in index:
                    issues.add("damaged", f"nodes.{key}")
            elif node_kinds.get(child) != (kind, 0):
                issues.add("damaged", f"nodes.{key}")
    for key, root in roots.items():
        v = root[0] if isinstance(root, list) and root else None
        if is_safe_int(v) and v > 1:
            issues.add("newer", f"roots.{key}")
            continue
        try:
            check_root_form(root)
            need(hash16(js_json(root).encode("utf-8")) == key, "root: hash")
        except Fail:
            unknown = (isinstance(root, list) and len(root) > 2 and isinstance(root[2], list)
                       and any(isinstance(pair, list) and pair and is_str(pair[0]) and not known_kind(pair[0]) for pair in root[2]))
            issues.add("newer" if unknown else "damaged", f"roots.{key}")
            continue
        if root[1] not in index:
            issues.add("damaged", f"roots.{key}")
        for kind, top in root[2]:
            node = node_kinds.get(top)
            if node is None or node[0] != kind:
                issues.add("damaged", f"roots.{key}")
                continue
    for i, e in enumerate(entries):
        if e.get("kept") is False:
            continue
        if e["snapshot"] not in roots:
            issues.add("damaged", f"entries[{i}]")
        for j, slot in enumerate(e.get("stack", {}).get("push", []) if e.get("kind") == "recovered" else []):
            if slot["snapshot"] not in roots:
                issues.add("damaged", f"entries[{i}].stack.push[{j}]")
    s = manifest["undoStack"]
    for i, slot in enumerate(s["slots"]):
        if slot["snapshot"] not in roots:
            issues.add("damaged", f"undoStack.slots[{i}]")
    at = s["index"] - s["base"]
    head = s["slots"][at]["snapshot"] if 0 <= at < len(s["slots"]) else None
    if s["index"] < s["base"] or head is None:
        issues.add("damaged", "undoStack.index")
    if len(issues) or head is None:
        return None, issues.done("history")
    return dict(entries=entries, roots=roots, nodes=nodes, index=index, head=head), []


def check_header_chunk(header):
    check_record("header", header, "header")
    check_header_refs(header, "header")


def read_history(z, pointers):
    def entry(name):
        e = z.get(name)
        if e is None or e["dir"]:
            raise ReadFailure("history-unreadable", name)
        return e

    def mapped(issues):
        names = {"damaged": "history-unreadable", "newer": "newer-history", "unknown-key": "unknown-key"}
        return [(names[r], p) for r, p in issues]

    try:
        total = 0
        for name in list(pointers.get("segments", [])) + [pointers["manifest"]]:
            e = z.get(name)
            if e is not None and not e["dir"]:
                total += e["usize"]
        if total > CAPS["history"]:
            raise ReadFailure("damaged", "history")
        segments = []
        for i, name in enumerate(pointers.get("segments", [])):
            part, issues = check_part(read_entry_json(z, entry(name), CAPS["manifest"]), f"segments[{i}]", False)
            if part is None:
                return None, mapped(issues)
            segments.append(part)
        manifest, issues = check_part(read_entry_json(z, entry(pointers["manifest"]), CAPS["manifest"]), "manifest", True)
        if manifest is None:
            return None, mapped(issues)
        ce = entry(pointers["chunks"])
        if ce["usize"] > CAPS["chunks"] or (ce["csize"] != ce["usize"] if ce["method"] == 0 else ce["csize"] > 2 * ce["usize"] + 1024):
            raise ReadFailure("damaged", ce["name"])
        history, issues = combine_parts(segments, manifest, pointers["entries"], ce["usize"])
        if history is None:
            return None, mapped(issues)
    except ReadFailure as failure:
        return None, [failure.item]

    whole = []

    def stored(h):
        off, length = history["index"][h]
        if ce["method"] == 0:
            if ce["csize"] != ce["usize"]:
                raise ZipBad("size")
            return z.stored(ce)[off:off + length]
        if not whole:
            whole.append(z.read(ce, CAPS["chunks"]))
        return whole[0][off:off + length]

    def chunk(h):
        raw = inflate_chunk(stored(h), CAPS["chunk"])
        need(hash16(raw) == h, f"chunk {h}: hash")
        return read_json_text(raw)

    checked = set()
    for key, root in history["roots"].items():
        if root[1] in checked:
            continue
        try:
            check_header_chunk(chunk(root[1]))
        except (Fail, ZipBad, JsonBad, KeyError, TypeError, IndexError, ValueError):
            return None, [("history-unreadable", f"roots.{key}")]
        checked.add(root[1])
    head = history["head"]
    try:
        root = history["roots"][head]
        check_root_form(root)
        header = chunk(root[1])
        check_header_chunk(header)
        ids = check_header_refs(header, "header")
        notes = 0
        for kind, top in root[2]:
            node = history["nodes"][top]
            check_record("node", node, "node")
            need(node[0] == kind and node[1] in (0, 1), "node")
            hashes = node[2]
            if node[1] == 1:
                hashes = []
                for child in node[2]:
                    leaf = history["nodes"][child]
                    check_record("node", leaf, "node")
                    need(leaf[0] == kind and leaf[1] == 0, "node")
                    hashes += leaf[2]
            form = FIELDS["kinds"][kind]
            for h in hashes:
                records = chunk(h)
                need(isinstance(records, list), "chunk: not an array")
                for record in records:
                    check_record(form, record, kind)
                    check_refs(form, record, ids, kind)
                if kind == "slides":
                    notes += sum(len(slide) for slide in records)
        need(notes == root[3], "root.noteCount")
    except (Fail, ZipBad, JsonBad, KeyError, TypeError, IndexError, ValueError):
        return None, [("history-unreadable", f"roots.{head}")]
    return history, []


def read_entry_json(z, e, cap):
    try:
        data = z.read(e, cap)
    except (ZipBad, struct.error):
        raise ReadFailure("damaged", e["name"])
    try:
        return read_json_text(data)
    except JsonBad:
        raise ReadFailure("damaged", e["name"])


def is_ignored(e):
    if e["dir"]:
        return True
    key = e["key"]
    if key.startswith("__MACOSX/") or key.startswith("cache/"):
        return True
    last = key[key.rfind("/") + 1:]
    return last in IGNORED_NAMES or last.startswith("._")


def read_nxsp(blob, info=None):
    """The editor's readNxsp: (kind, open, [(reason, path)]). `info`, when given, also gets `savedAt`."""
    report = []
    try:
        z = Zip(blob)
    except (ZipBad, struct.error):
        return "unreadable", None, [("damaged", "")]
    if z.recovered:
        report.append(("damaged", ""))
    for name in z.duplicates:
        report.append(("damaged", name))
    for name in sorted(z.overlapping):
        report.append(("damaged", name))
    for name in sorted(z.real_overlapping - z.overlapping):
        report.append(("damaged", name))
    try:
        pe = z.get("project.json")
        if pe is None:
            return ("unreadable", None, report) if "project.json" in z.ambiguous else ("not-project", None, [])
        pj = read_entry_json(z, pe, CAPS["project"])
        if not isinstance(pj, dict) or pj.get("format") != "nxsp" or isinstance(pj.get("format"), bool):
            return "not-project", None, []
        version = pj.get("version")
        newer_major = is_safe_int(version) and version > 1
        project = None
        if newer_major:
            report.append(("newer-version", "version"))
        else:
            if not (is_int(version) and version == 1):
                report.append(("invalid-key", "version"))
            project, issues = read_project(pj)
            if info is not None:
                info["savedAt"] = project["saved_at"]
            for reason, path in issues:
                report.append(({"unknown-key": "unknown-key", "schema": "invalid-key"}.get(reason, "damaged"), path))
            if project["minor"] > 0:
                report.append(("newer-minor", "minor"))
            if project["patch"] > 0:
                report.append(("newer-patch", "patch"))
            if project["levelVersion"] > 1:
                report.append(("newer-level", "levelVersion"))
        pointers = []
        if project:
            pointers.append(("level", project["level"], "level.json"))
            if project["bgm"] and "file" in project["bgm"]:
                pointers.append(("bgm.file", project["bgm"]["file"], "bgm/"))
            for kind in ("cover", "preview"):
                m = project["metadata"].get(kind)
                if m and "file" in m:
                    pointers.append((f"metadata.{kind}.file", m["file"], f"assets/{kind}."))
            h = project["history"]
            if h:
                pointers.append(("history.manifest", h["manifest"], "history/"))
                pointers.append(("history.chunks", h["chunks"], "history/"))
                for i, name in enumerate(h.get("segments", [])):
                    pointers.append((f"history.segments[{i}]", name, "history/"))
        named = {}
        for path, name, prefix in pointers:
            key = unicodedata.normalize("NFC", name)
            if (key != prefix) if prefix == "level.json" else (not key.startswith(prefix) or key == prefix):
                report.append(("damaged", path))
            if key in named:
                report.append(("damaged", path))
            named[key] = path
        if not newer_major:
            for e in z.entries:
                if is_ignored(e) or e["key"] == "project.json" or e["key"] in named:
                    continue
                report.append(("unknown-entry", e["name"]))
        le = z.get("level.json")
        if le is None:
            report.append(("damaged", "level.json"))
            return "unreadable", None, report
        level = read_entry_json(z, le, CAPS["level"])
        if isinstance(level, dict):
            for key in level:
                if key not in ("bgmOffset", "entities"):
                    report.append(("unknown-key", f"level.json.{key}"))
        if project:
            for kind in ("bgm", "cover", "preview"):
                form = project["bgm"] if kind == "bgm" else project["metadata"].get(kind)
                if not form or "file" not in form:
                    continue
                path = "bgm.file" if kind == "bgm" else f"metadata.{kind}.file"
                e = z.get(form["file"])
                if e is None or e["dir"]:
                    report.append(("media-unreadable", path))
                    continue
                if e["usize"] > CAPS["media"]:
                    report.append(("damaged", e["name"]))
                    continue
                try:
                    data = z.read(e, CAPS["media"])
                except (ZipBad, struct.error):
                    report.append(("damaged", e["name"]))
                    continue
                if len(data) != form["size"] or hashlib.sha256(data).hexdigest() != form["sha256"]:
                    report.append(("media-unreadable", path))
            damaged = any(r == "damaged" for r, _ in report)
            newer_minor = any(r == "newer-minor" for r, _ in report)
            if project["history"] and not damaged and not newer_minor:
                _, items = read_history(z, project["history"])
                report += items
        # A newer `patch` alone is a notice, never a partial open.
        return "nxsp", "partial" if any(r != "newer-patch" for r, _ in report) else "full", report
    except ReadFailure as failure:
        report.append(failure.item)
        return "unreadable", None, report


def read_main(paths):
    status = 0
    for path in paths:
        try:
            info = {}
            with open(path, "rb") as f:
                kind, opened, report = read_nxsp(f.read(), info)
            # ASCII only, so no console code page or lone surrogate can break the line.
            print(json.dumps({"file": path, "kind": kind, "open": opened, "report": [list(r) for r in report],
                              "savedAt": info.get("savedAt")}, ensure_ascii=True))
        except Exception as error:  # A crash is the checker's bug: say so, never pass.
            print(json.dumps({"file": path, "error": f"{type(error).__name__}: {error}"}, ensure_ascii=True))
            status = 1
    return status


def main(argv):
    # Paths and messages may hold any character: never let a console code page crash a run.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    if argv[:1] == ["--show"] and len(argv) == 3:
        show(argv[1], argv[2])
        return 0
    if argv[:1] == ["--read"]:
        return read_main(argv[1:])
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    infos, failed = [], False
    for path in argv:
        try:
            infos.append(check_file(path))
            print(f"ok {path}")
        except Fail as error:
            print(f"FAIL {path}: {error}")
            failed = True
        except Exception as error:  # A malformed file the checks didn't foresee still fails.
            print(f"FAIL {path}: {type(error).__name__}: {error}")
            failed = True
    try:
        check_complete_from(infos)
    except Fail as error:
        print(f"FAIL {error}")
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
