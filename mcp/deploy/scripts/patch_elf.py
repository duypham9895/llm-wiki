#!/usr/bin/env python3
"""Clear the PF_X flag on PT_GNU_STACK ELF program headers for a glob of .so files.

Newer hardened kernels (hostinger VPS, grsecurity-style) refuse to load .so files
that have an executable stack flag set, raising:
  ImportError: ... cannot enable executable stack as shared object requires

This script reads each file, finds the PT_GNU_STACK segment, and clears its
PF_X bit. Safe no-op if PT_GNU_STACK is absent or already clear.

Used in mcp/deploy/Dockerfile as a build step.
"""
import struct
import glob
import sys


def patch(path: str) -> None:
    with open(path, "rb") as f:
        data = bytearray(f.read())

    if data[:4] != b"\x7fELF":
        print(f"{path}: not ELF, skipping")
        return

    cls = data[4]  # 1=32-bit, 2=64-bit
    little = data[5] == 1
    endian = "<" if little else ">"

    if cls == 2:
        e_phoff = struct.unpack_from(endian + "Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from(endian + "H", data, 0x36)[0]
        e_phnum = struct.unpack_from(endian + "H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from(endian + "I", data, 0x1c)[0]
        e_phentsize = struct.unpack_from(endian + "H", data, 0x2a)[0]
        e_phnum = struct.unpack_from(endian + "H", data, 0x2c)[0]

    PT_GNU_STACK = 0x6474E551
    PF_X = 0x1

    found = False
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from(endian + "I", data, off)[0]
        if p_type == PT_GNU_STACK:
            found = True
            flags_off = off + 4
            old_flags = struct.unpack_from(endian + "I", data, flags_off)[0]
            new_flags = old_flags & ~PF_X
            if old_flags == new_flags:
                print(f"{path}: PT_GNU_STACK already clear (flags={old_flags:#x})")
                return
            data[flags_off:flags_off + 4] = struct.pack(endian + "I", new_flags)
            with open(path, "wb") as f:
                f.write(data)
            print(f"{path}: cleared PF_X (was {old_flags:#x}, now {new_flags:#x})")
            return

    if not found:
        print(f"{path}: no PT_GNU_STACK segment, skipping")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: patch_elf.py <glob>", file=sys.stderr)
        return 1
    for pattern in sys.argv[1:]:
        for path in glob.glob(pattern):
            patch(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())