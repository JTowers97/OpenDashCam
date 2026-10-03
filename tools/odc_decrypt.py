#!/usr/bin/env python3
"""
Decrypt Open Dash Cam encrypted files (.odcenc): encrypted uploads and clips encrypted on the phone.

Usage:
    pip install cryptography
    python3 odc_decrypt.py FILE_OR_FOLDER [more ...]        # writes decrypted copies next to the originals
    python3 odc_decrypt.py -o OUTPUT_DIR FILE_OR_FOLDER     # writes them to OUTPUT_DIR instead

Folders are searched recursively. The passphrase is asked for once (or set ODC_PASSPHRASE).

File format (see app/src/main/java/org/opendashcam/backup/OdcEncryption.kt):
  header 53 bytes: magic "ODCENC1\\n" | version u8 | salt[16] | iterations u32 BE | chunk size u32 BE
                   | nonce prefix[4] | key check[16]
  chunks: nonce[12] | AES-256-GCM ciphertext+tag; AAD = header | chunk index u64 BE | final flag u8
"""
import argparse
import getpass
import hashlib
import hmac
import os
import struct
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"ODCENC1\n"
HEADER_LEN = 53
OVERHEAD = 12 + 16

_key_cache = {}


def derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    k = (salt, iterations)
    if k not in _key_cache:
        _key_cache[k] = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations, 32)
    return _key_cache[k]


def decrypt_file(src: str, dst: str, passphrase: str) -> None:
    size = os.path.getsize(src)
    with open(src, "rb") as f:
        header = f.read(HEADER_LEN)
        if len(header) < HEADER_LEN or header[:8] != MAGIC:
            raise ValueError("not an ODC encrypted file")
        salt = header[9:25]
        iterations, chunk_size = struct.unpack(">II", header[25:33])
        prefix = header[33:37]
        key = derive_key(passphrase, salt, iterations)
        check = hmac.new(key, b"ODC key check", hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(check, header[37:53]):
            raise ValueError("wrong passphrase")
        aes = AESGCM(key)
        remaining = size - HEADER_LEN
        index = 0
        tmp = dst + ".tmp"
        with open(tmp, "wb") as out:
            while True:
                enc_len = min(remaining, chunk_size + OVERHEAD)
                if enc_len < OVERHEAD:
                    raise ValueError("file is truncated")
                block = f.read(enc_len)
                remaining -= enc_len
                final = remaining == 0
                nonce, ct = block[:12], block[12:]
                if nonce != prefix + struct.pack(">Q", index):
                    raise ValueError(f"chunk {index} is out of order")
                aad = header + struct.pack(">QB", index, 1 if final else 0)
                try:
                    out.write(aes.decrypt(nonce, ct, aad))
                except InvalidTag:
                    raise ValueError(f"chunk {index} is damaged or the file is incomplete") from None
                index += 1
                if final:
                    break
        os.replace(tmp, dst)


def collect(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                for name in sorted(files):
                    if name.endswith(".odcenc"):
                        yield os.path.join(root, name)
        else:
            yield p


def main() -> int:
    ap = argparse.ArgumentParser(description="Decrypt Open Dash Cam .odcenc files")
    ap.add_argument("paths", nargs="+")
    ap.add_argument("-o", "--output", help="folder for decrypted files (default: next to each file)")
    args = ap.parse_args()

    passphrase = os.environ.get("ODC_PASSPHRASE") or getpass.getpass("Passphrase: ")
    ok = failed = 0
    for src in collect(args.paths):
        name = os.path.basename(src)
        out_name = name[: -len(".odcenc")] if name.endswith(".odcenc") else name + ".decrypted"
        if "." not in out_name:
            out_name += ".mp4"  # clips encrypted on the phone: ODC_..._rear.odcenc -> ODC_..._rear.mp4
        out_dir = args.output or os.path.dirname(src)
        os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, out_name)
        try:
            decrypt_file(src, dst, passphrase)
            print(f"ok      {src} -> {dst}")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"FAILED  {src}: {e}", file=sys.stderr)
            failed += 1
    print(f"{ok} decrypted, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
