"""tools/audio/bands.py - octave-ish band energy (dB, relative to loudest band) per WAV over a window.
usage: python tools/audio/bands.py [--from 0] [--to 0.3] a.wav b.wav ...
Also prints decay times: time until the broadband envelope falls 20/40/60 dB below its peak."""
import sys, wave
import numpy as np

args = list(sys.argv[1:])
t0, t1 = 0.0, None
for key in ('--from', '--to'):
    if key in args:
        i = args.index(key); v = float(args[i + 1]); del args[i:i + 2]
        if key == '--from': t0 = v
        else: t1 = v
BANDS = [(20, 60), (60, 120), (120, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000), (16000, 24000)]
print('file'.ljust(38) + ''.join(f'{a}-{b}'.rjust(10) for a, b in BANDS) + '   t-20  t-40  t-60')
for f in args:
    w = wave.open(f, 'rb'); n = w.getnframes(); ch = w.getnchannels(); sr = w.getframerate()
    x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64) / 32768.0
    m = x.reshape(-1, ch).mean(1)
    seg = m[int(t0 * sr): int(t1 * sr) if t1 else len(m)]
    F = np.abs(np.fft.rfft(seg)) ** 2
    fr = np.fft.rfftfreq(len(seg), 1 / sr)
    e = [10 * np.log10(F[(fr >= a) & (fr < b)].sum() + 1e-20) for a, b in BANDS]
    mx = max(e)
    # envelope decay (10 ms RMS windows)
    hop = int(0.005 * sr); win = int(0.01 * sr)
    env = np.array([np.sqrt((m[i:i + win] ** 2).mean() + 1e-20) for i in range(0, max(1, len(m) - win), hop)])
    edb = 20 * np.log10(env / env.max())
    ip = int(np.argmax(env))
    def tdrop(d):
        idx = np.where(edb[ip:] < -d)[0]
        return f'{(ip + idx[0]) * hop / sr:.3f}' if len(idx) else '  -  '
    name = f.replace('\\', '/').split('/')[-1][:37]
    print(name.ljust(38) + ''.join(f'{v - mx:10.1f}' for v in e) + f'  {tdrop(20)} {tdrop(40)} {tdrop(60)}')
