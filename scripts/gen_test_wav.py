#!/usr/bin/env python3
"""Generate WAV sine mono utk uji split. Jalankan: python scripts/gen_test_wav.py [durasi_detik]"""
import math
import struct
import sys
import wave

dur = int(sys.argv[1]) if len(sys.argv) > 1 else 480
sr = 22050
with wave.open("tmp/e2e-split.wav", "w") as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(sr)
    frames = bytearray()
    for t in range(dur * sr):
        v = int(9000 * math.sin(2 * math.pi * 440 * t / sr))
        frames += struct.pack("<h", v)
    f.writeframes(bytes(frames))
print(f"ok tmp/e2e-split.wav {dur}s")
