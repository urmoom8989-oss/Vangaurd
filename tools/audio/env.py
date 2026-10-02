"""tools/audio/env.py - short-time envelope (dB re peak) of WAVs, for judging transient vs body vs tail.
usage: python tools/audio/env.py a.wav [b.wav ...] [--win 5] [--until 1.0] [--step 1]"""
import sys, wave
import numpy as np
args = list(sys.argv[1:]); win, until, step = 5.0, 1.0, 1
for key in ('--win', '--until', '--step'):
    if key in args:
        i = args.index(key); v = float(args[i + 1]); del args[i:i + 2]
        if key == '--win': win = v
        elif key == '--until': until = v
        else: step = int(v)
for f in args:
    w = wave.open(f, 'rb'); n = w.getnframes(); ch = w.getnchannels(); sr = w.getframerate()
    x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64) / 32768.0
    m = x.reshape(-1, ch)
    pk = np.abs(m).max()
    hop = int(win / 1000 * sr)
    rows = []
    for k in range(0, min(len(m), int(until * sr)), hop):
        seg = m[k:k + hop]
        rows.append((k / sr, 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9), 20 * np.log10(np.abs(seg).max() + 1e-9)))
    print(f.replace(chr(92), '/').split('/')[-1], 'peak %.1f dBFS' % (20 * np.log10(pk)))
    print('  ' + ' '.join(f'{t*1000:4.0f}:{r:5.1f}' for i, (t, r, p) in enumerate(rows) if i % step == 0))
