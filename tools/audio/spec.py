"""tools/audio/spec.py - high-resolution analysis sheet for one or more WAVs (numpy + PIL only).
usage: python tools/audio/spec.py out.png a.wav [b.wav ...] [--zoom 0.15] [--fmax 20000] [--win 512]
Each row: waveform (full), zoomed waveform (first --zoom seconds), log-freq spectrogram (short window
for transients) and a long-window average spectrum. Labels include peak/RMS/crest/centroid."""
import sys, wave
import numpy as np
from PIL import Image, ImageDraw


def load(p):
    w = wave.open(p, 'rb')
    n = w.getnframes(); ch = w.getnchannels(); sr = w.getframerate()
    d = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return d.reshape(-1, ch).T, sr


def cmap(t):
    t = np.clip(t, 0, 1)
    r = np.clip(1.6 * t, 0, 1)
    g = np.clip(1.5 * t - 0.5, 0, 1)
    b = np.clip(np.where(t < 0.4, 1.8 * t, np.maximum(0, 1.2 - 1.3 * t) + np.maximum(0, t - 0.85) * 4), 0, 1)
    return (np.stack([r, g, b], -1) * 255).astype(np.uint8)


args = list(sys.argv[1:])
zoom, fmax, N = 0.15, 20000.0, 512
for key in ('--zoom', '--fmax', '--win'):
    if key in args:
        i = args.index(key); v = float(args[i + 1]); del args[i:i + 2]
        if key == '--zoom': zoom = v
        elif key == '--fmax': fmax = v
        else: N = int(v)
out, files = args[0], args[1:]
W, RH = 1800, 300
img = Image.new('RGB', (W, RH * len(files)), (13, 15, 18))
dr = ImageDraw.Draw(img)


def wave_plot(sig, X, Y, w, h, col):
    dr.rectangle([X, Y, X + w, Y + h], fill=(22, 26, 32))
    dr.line([X, Y + h / 2, X + w, Y + h / 2], fill=(50, 50, 50))
    spp = max(1e-9, len(sig) / w)
    for i in range(w):
        a = int(i * spp); b = int(min(len(sig), (i + 1) * spp + 1))
        if a >= len(sig): break
        seg = sig[a:b]
        mn, mx = float(seg.min()), float(seg.max())
        dr.line([X + i, Y + h / 2 - mx * h / 2, X + i, Y + h / 2 - mn * h / 2], fill=col)


for row, f in enumerate(files):
    x, sr = load(f)
    m = x.mean(0); n = len(m); y0 = row * RH
    pk = np.abs(x).max() + 1e-12; rms = np.sqrt((x ** 2).mean()) + 1e-12
    wave_plot(m, 10, y0 + 20, 420, 120, (79, 195, 247))
    wave_plot(m[: max(2, int(zoom * sr))], 10, y0 + 160, 420, 120, (255, 180, 80))
    hop = max(1, (n - N) // 900)
    win = np.hanning(N)
    cols = [np.abs(np.fft.rfft(np.pad(m[s:s + N], (0, max(0, N - len(m[s:s + N])))) * win)) for s in range(0, max(1, n - N), hop)]
    S = np.array(cols).T + 1e-12
    db = 20 * np.log10(S / (N / 4))
    freqs = np.fft.rfftfreq(N, 1 / sr)
    H = 260; lmin, lmax = np.log(30), np.log(min(fmax, sr / 2))
    fy = np.exp(lmax - np.arange(H) / (H - 1) * (lmax - lmin))
    idx = np.clip(np.searchsorted(freqs, fy), 1, len(freqs) - 1)
    spec = db[idx, :]
    im = Image.fromarray(cmap((spec + 100) / 100)).resize((900, H))
    img.paste(im, (450, y0 + 20))
    for fq in [50, 100, 200, 500, 1000, 2000, 5000, 10000]:
        yy = y0 + 20 + (lmax - np.log(fq)) / (lmax - lmin) * (H - 1)
        dr.text((1355, yy - 6), f'{fq // 1000}k' if fq >= 1000 else str(fq), fill=(170, 170, 170))
    dur = n / sr
    for k in range(6):
        dr.text((450 + k * 180, y0 + 282), f'{dur * k / 5:.2f}s', fill=(150, 150, 150))
    L = 8192
    seg = np.pad(m, (0, max(0, L - n)))
    P = np.zeros(L // 2 + 1)
    for s in range(0, max(1, len(seg) - L + 1), L // 2):
        P += np.abs(np.fft.rfft(seg[s:s + L] * np.hanning(L))) ** 2
    Pdb = 10 * np.log10(P + 1e-20); Pdb -= Pdb.max()
    fr = np.fft.rfftfreq(L, 1 / sr)
    X0, Y0, w, h = 1390, y0 + 20, 400, 260
    dr.rectangle([X0, Y0, X0 + w, Y0 + h], fill=(22, 26, 32))
    pts = []
    for i in range(w):
        fq = np.exp(np.log(20) + i / w * (np.log(sr / 2) - np.log(20)))
        k = min(len(fr) - 1, int(fq / (sr / L)))
        pts.append((X0 + i, Y0 + min(h, -Pdb[k] / 80 * h)))
    dr.line(pts, fill=(120, 255, 140))
    for fq in [100, 1000, 10000]:
        xx = X0 + (np.log(fq) - np.log(20)) / (np.log(sr / 2) - np.log(20)) * w
        dr.line([xx, Y0, xx, Y0 + h], fill=(60, 60, 60))
        dr.text((xx + 2, Y0 + h - 12), f'{fq}', fill=(150, 150, 150))
    F = np.abs(np.fft.rfft(m)); cen = (F * np.fft.rfftfreq(n, 1 / sr)).sum() / (F.sum() + 1e-12)
    name = f.replace('\\', '/').split('/')[-1]
    dr.text((10, y0 + 4), f'{name}  {dur:.2f}s  ch{x.shape[0]}  peak {20 * np.log10(pk):.1f}dB  rms {20 * np.log10(rms):.1f}dB  crest {20 * np.log10(pk / rms):.1f}dB  centroid {cen:.0f}Hz   [zoom {zoom}s]', fill=(230, 230, 230))
img.save(out)
print(out)
