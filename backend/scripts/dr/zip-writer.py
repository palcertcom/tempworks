#!/usr/bin/env python3
"""Bounded-memory ZIP64 writer. Never finalise an interrupted export."""
import json
import os
import struct
import sys
import zipfile


def exact(n):
    data = bytearray()
    while len(data) < n:
        chunk = sys.stdin.buffer.read(n - len(data))
        if not chunk:
            raise EOFError('incomplete export')
        data.extend(chunk)
    return bytes(data)


def run():
    archive = zipfile.ZipFile(sys.stdout.buffer, 'w', compression=zipfile.ZIP_DEFLATED,
                              compresslevel=6, allowZip64=True)
    entry = None
    names = set()
    while True:
        op = exact(1)
        if op in (b'N', b'D'):
            size = struct.unpack('>I', exact(4))[0]
            if size > 1024 * 1024:
                raise ValueError('oversized frame')
            data = exact(size)
        if op == b'N':
            if entry is not None:
                raise ValueError('entry already open')
            name = json.loads(data)['name']
            if (not name or name.startswith('/') or '\\' in name or ':' in name
                    or any(p in ('', '.', '..') for p in name.split('/'))
                    or any(ord(c) < 32 for c in name) or name in names):
                raise ValueError('unsafe or duplicate archive path')
            names.add(name)
            entry = archive.open(name, 'w', force_zip64=True)
        elif op == b'D':
            if entry is None:
                raise ValueError('no open entry')
            entry.write(data)
        elif op == b'E':
            if entry is None:
                raise ValueError('no open entry')
            entry.close()
            entry = None
        elif op == b'F':
            if entry is not None:
                raise ValueError('unfinished entry')
            archive.close()
            sys.stdout.buffer.flush()
            return
        else:
            raise ValueError('invalid export frame')


if __name__ == '__main__':
    try:
        run()
    except BaseException:
        # Avoid ZipFile.__del__ writing a valid central directory after failure.
        sys.stderr.write('ZIP export interrupted; discard the incomplete download.\n')
        sys.stderr.flush()
        os._exit(1)
