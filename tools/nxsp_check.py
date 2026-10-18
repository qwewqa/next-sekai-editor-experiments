#!/usr/bin/env python3
"""The independent checker for .nxsp v1 files (Part 1 §1.6.11.9).

Standard library only, sharing no code with the editor: it reads `fields-v1.json` (a copy that
`npm run format:gen` writes beside it) and checks what a v1 writer must write: every ZIP header pin,
the entry order and methods, CRCs, the end record, `project.json` and its pointers, the reader caps,
every record's arity and types, the roots and nodes under their own hashes, `chunks.bin` tiling,
every chunk inflated with the strict end check and hashed, the closure of every root, `summary`,
`history.entries`, the undo stack, and `revision.completeFrom`, placed and, when the file of the
revision it names (or one between) is also given, checked against that file's rows.

    uv run python -I tools/nxsp_check.py FILE...
    uv run python -I tools/nxsp_check.py --show FILE HASH
"""

import hashlib
import json
import math
import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "fields-v1.json"), encoding="utf-8") as f:
    FIELDS = json.load(f)

MB = 1024 * 1024
CAPS = {"project": MB, "level": 64 * MB, "manifest": 256 * MB, "chunks": 2048 * MB,
        "chunk": 16 * MB, "media": 1024 * MB, "depth": 64, "entries": 65535, "segments": 4096}
SAFE = 2 ** 53 - 1
HEX16 = re.compile(r"^[0-9a-f]{32}$")
HEX32 = re.compile(r"^[0-9a-f]{64}$")
ENTRY_KINDS = {"init", "continue", "edit", "undo", "redo", "restore", "save", "export", "recovered"}
STORE_PREFIXES = ("history/chunks.bin", "assets/", "bgm/")


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


def is_int(v):
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and float(v).is_integer()


def is_uint(v):
    return is_int(v) and 0 <= v <= SAFE


def is_id(v):
    return is_int(v) and 0 < v <= SAFE


def is_number(v):
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def is_str(v):
    return isinstance(v, str)


def is_hash(v):
    return isinstance(v, str) and HEX16.match(v) is not None


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


# ZIP

def dos_of(saved_at):
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$", saved_at)
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
        need(re.match(r"^[\x21-\x7e]+$", name) is not None, f"{name!r}: not an ASCII name")
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
        need(isinstance(form.get("sha256"), str) and HEX32.match(form["sha256"]), f"{what}.sha256")
        entry = entries_by_name.get(form["file"])
        need(entry is not None, f"{what}.file: no entry {form['file']}")
        need(len(entry["data"]) <= CAPS["media"], f"{what}: over the media cap")
        need(form.get("size") == len(entry["data"]), f"{what}.size: not the entry's size")
        need(hashlib.sha256(entry["data"]).hexdigest() == form["sha256"], f"{what}.sha256: not the entry's")
    else:
        keys_within(form, ["filename", "type", "hash", "size"], what)
        need(is_hash(form.get("hash")), f"{what}.hash")
        need(is_uint(form.get("size")), f"{what}.size")
    need(is_str(form.get("type")), f"{what}.type")
    if "filename" in form:
        need(is_str(form["filename"]) and form["filename"] != "", f"{what}.filename: empty")
    return form.get("file")


def entry_form(e, path):
    need(isinstance(e, dict), f"{path}: not an object")
    keys_within(e, ["kind", "time", "label", "snapshot", "noteCount", "dirty", "kept", "revisionId",
                    "device", "stack", "x"], path)
    need(e.get("kind") in ENTRY_KINDS, f"{path}.kind")
    need(is_number(e.get("time")), f"{path}.time")
    need(is_str(e.get("label")), f"{path}.label")
    need(is_hash(e.get("snapshot")), f"{path}.snapshot")
    need(is_uint(e.get("noteCount")), f"{path}.noteCount")
    need(e.get("dirty", True) is True, f"{path}.dirty: only true")
    need(e.get("kept", False) is False, f"{path}.kept: only false")
    if e["kind"] == "save":
        need(is_str(e.get("revisionId")), f"{path}.revisionId")
        d = e.get("device")
        keys_within(d, ["id", "label"], f"{path}.device")
        need(is_str(d.get("id")) and is_str(d.get("label")), f"{path}.device")
    else:
        need("revisionId" not in e and "device" not in e, f"{path}: revisionId or device off a save")
    if e["kind"] == "recovered":
        s = e.get("stack")
        keys_within(s, ["keep", "push", "index"], f"{path}.stack")
        need(is_uint(s.get("keep")) and is_uint(s.get("index")) and isinstance(s.get("push"), list), f"{path}.stack")
        for i, slot in enumerate(s["push"]):
            slot_form(slot, f"{path}.stack.push[{i}]")
    else:
        need("stack" not in e, f"{path}: stack off a recovered entry")
    need(isinstance(e.get("x", {}), dict), f"{path}.x: not an object")


def slot_form(slot, path):
    keys_within(slot, ["snapshot", "label"], path)
    need(is_hash(slot.get("snapshot")) and is_str(slot.get("label")), path)


def canonical(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def hash16(data):
    return hashlib.sha256(data).hexdigest()[:32]


def js_round(x):
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def duration_ms(slides, bpms):
    beats = [note[2] for slide in slides for note in slide]
    if not beats:
        return 0
    last, time = max(beats), 0.0
    for i, bpm in enumerate(bpms):
        start = 0 if i == 0 else bpm[0]
        end = bpms[i + 1][0] if i + 1 < len(bpms) else math.inf
        if last <= start:
            break
        time += ((min(last, end) - start) * 60000) / bpm[1]
    result = js_round(time)
    return result if math.isfinite(time) and 0 < result <= SAFE else 0


def check_file(path):
    with open(path, "rb") as f:
        blob = f.read()
    entries = read_zip(blob)
    by_name = {e["name"]: e for e in entries}
    names = [e["name"] for e in entries]
    need(names[:2] == ["project.json", "level.json"], "project.json and level.json first")

    project = parse_json(by_name["project.json"]["data"], "project.json")
    need(len(by_name["project.json"]["data"]) <= CAPS["project"], "project.json: over its cap")
    need(isinstance(project, dict), "project.json: not an object")
    need("parts" not in project, "project.json: parts, which v0.6.0 never writes")
    need(project.get("format") == "nxsp" and project.get("version") == 1, "project.json: format or version")
    need(project.get("minor") == 0 and project.get("levelVersion") == 1, "project.json: minor or levelVersion")
    for key in ("appVersion", "id", "lineageId"):
        need(is_str(project.get(key)) and project[key] != "", f"project.json.{key}")
    for key in ("name", "exportName"):
        need(key not in project or is_str(project[key]), f"project.json.{key}")
    need(project.get("level") == "level.json", "project.json.level")

    rev = project.get("revision")
    keys_within(rev, ["id", "parent", "n", "savedAt", "device", "ancestors", "replaces", "fileName", "completeFrom"], "revision")
    need(is_str(rev.get("id")) and rev["id"] != "", "revision.id")
    need(rev.get("parent") is None or is_str(rev.get("parent")), "revision.parent")
    need(is_uint(rev.get("n")), "revision.n")
    keys_within(rev.get("device"), ["id", "label"], "revision.device")
    need(is_str(rev["device"].get("id")) and is_str(rev["device"].get("label")), "revision.device")
    ancestors = rev.get("ancestors")
    need(isinstance(ancestors, list) and all(is_str(a) for a in ancestors) and len(ancestors) <= 1024, "revision.ancestors")
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
        info["rows"] = check_history(project, history, segments, by_name, summary, rev)
        info["completeFrom"] = rev["completeFrom"]

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
        expected = 0 if e["name"].startswith(STORE_PREFIXES) else 8
        need(e["method"] == expected, f"{e['name']}: method {e['method']}")
    return info


def history_order(history):
    if history is None:
        return []
    return list(history.get("segments", [])) + ["history/manifest.json", "history/chunks.bin"]


def check_history(project, history, segments, by_name, summary, rev):
    parts = []
    for name in segments:
        need(len(by_name[name]["data"]) <= CAPS["manifest"], f"{name}: over its cap")
        part = parse_json(by_name[name]["data"], name)
        keys_within(part, ["entries", "roots", "nodes", "chunks"], name)
        need(set(part) == {"entries", "roots", "nodes", "chunks"}, f"{name}: a key missing")
        parts.append((name, part))
    data = by_name["history/manifest.json"]["data"]
    need(len(data) <= CAPS["manifest"], "manifest: over its cap")
    manifest = parse_json(data, "manifest")
    keys_within(manifest, ["version", "entries", "roots", "nodes", "chunks", "undoStack"], "manifest")
    need(len(manifest) == 6 and manifest["version"] == 1, "manifest: version or a key missing")
    parts.append(("manifest", manifest))

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
                need(target.get(key, value) == value, f"{name}.{kind}.{key}: two values")
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
    need(len(entries) == history.get("entries"), "history.entries: not the entry count")

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
    keys_within(stack, ["base", "slots", "index"], "undoStack")
    need(is_uint(stack.get("base")) and is_uint(stack.get("index")) and isinstance(stack.get("slots"), list), "undoStack")
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
    """A file's `completeFrom` against every given file between that revision and it (§1.6.11.9)."""
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


def main(argv):
    if argv[:1] == ["--show"] and len(argv) == 3:
        show(argv[1], argv[2])
        return 0
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
    try:
        check_complete_from(infos)
    except Fail as error:
        print(f"FAIL {error}")
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
