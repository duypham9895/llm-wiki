FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN pip install --no-cache-dir poetry==1.8.3

# deps first (layer cache)
COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false && poetry install --only main --no-root

COPY prd_mcp ./prd_mcp
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini
COPY deploy/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Patch onnxruntime's .so to not require executable stack.
# Newer hardened kernels (hostinger, grsecurity) refuse .so files with
# READ_IMPLIES_EXEC personality. Clearing the PF_X bit on the PT_GNU_STACK
# ELF segment header avoids the "cannot enable executable stack" error.
# We don't actually use chromadb's default EF (OpenAI embeddings via
# env_secret), so this is purely an import-time guard.
# Uses python3 (already in the image) — no apt packages needed.
RUN python3 -c "
import struct, glob, os
for path in glob.glob('/usr/local/lib/python3.10/site-packages/onnxruntime/capi/*.so'):
    with open(path, 'r+b') as f:
        data = f.read()
    # Find ELF magic + class
    if data[:4] != b'\\x7fELF':
        continue
    cls = data[4]  # 1=32-bit, 2=64-bit
    little = data[5] == 1
    endian = '<' if little else '>'
    # ELF64: e_phoff at offset 0x20 (8 bytes), e_phentsize at 0x36 (2), e_phnum at 0x38 (2)
    # ELF32: e_phoff at offset 0x1c (4 bytes), e_phentsize at 0x2a (2), e_phnum at 0x2c (2)
    if cls == 2:
        e_phoff = struct.unpack_from('<Q', data, 0x20)[0]
        e_phentsize = struct.unpack_from('<H', data, 0x36)[0]
        e_phnum = struct.unpack_from('<H', data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from('<I', data, 0x1c)[0]
        e_phentsize = struct.unpack_from('<H', data, 0x2a)[0]
        e_phnum = struct.unpack_from('<H', data, 0x2c)[0]
    PT_GNU_STACK = 0x6474e551
    PF_X = 0x1
    modified = False
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from('<I', data, off)[0]
        if p_type == PT_GNU_STACK:
            # p_flags is at offset 4 in the program header (ELF64: 4 bytes; ELF32: 4 bytes)
            flags_off = off + 4
            old_flags = struct.unpack_from('<I', data, flags_off)[0]
            new_flags = old_flags & ~PF_X
            if old_flags != new_flags:
                f.seek(flags_off)
                f.write(struct.pack('<I', new_flags))
                modified = True
                print(f'{path}: cleared PF_X (was {old_flags:#x}, now {new_flags:#x})')
            break
    if not modified:
        print(f'{path}: no PT_GNU_STACK or already cleared')
"

EXPOSE 8300
ENTRYPOINT ["./entrypoint.sh"]
