/**
 * Vehicle detail atlas (1024x512 canvas): grilles, lamps, plates, route boards, burnt fascias.
 * Deterministic (seeded rng). Cells are looked up with textures.carCell(name).
 */
export function drawVehicleAtlas(g, rng, drawNoise) {
  g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, 1024, 512);
  const lens = (x, y, r, tint = [205, 212, 215], broken = false) => {
    let gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r * 1.15);
    gr.addColorStop(0, '#d8d8d4'); gr.addColorStop(0.6, '#8a8a88'); gr.addColorStop(1, '#3a3a3a');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 1.15, 0, Math.PI * 2); g.fill();
    gr = g.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.05, x, y, r);
    gr.addColorStop(0, `rgb(${tint[0] + 40},${tint[1] + 40},${tint[2] + 40})`);
    gr.addColorStop(0.45, `rgb(${tint[0]},${tint[1]},${tint[2]})`);
    gr.addColorStop(1, `rgb(${tint[0] * 0.45 | 0},${tint[1] * 0.45 | 0},${tint[2] * 0.45 | 0})`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (let k = -r; k < r; k += 4) {
      const h = Math.sqrt(Math.max(0, r * r - k * k));
      g.beginPath(); g.moveTo(x + k, y - h); g.lineTo(x + k, y + h); g.stroke();
    }
    if (broken) {
      g.fillStyle = '#0c0c0c'; g.beginPath(); g.moveTo(x - r * 0.2, y - r); g.lineTo(x + r * 0.7, y - r * 0.2); g.lineTo(x + r * 0.1, y + r * 0.5); g.lineTo(x - r * 0.6, y + r * 0.1); g.closePath(); g.fill();
    }
  };
  const grime = (x, y, w, h, a = 0.35) => drawNoise(g, rng, x, y, w, h, { alpha: a, op: 'multiply', base: 8 });
  const text = (s, x, y, font, col) => { g.fillStyle = col; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, x, y); };

  // sedan front (0,0,512,128): chrome-framed black grille, twin round lamps each side, amber indicators, plate
  g.fillStyle = '#0f0f0f'; g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#9a9a96'; g.fillRect(118, 18, 276, 72);
  g.fillStyle = '#121212'; g.fillRect(124, 24, 264, 60);
  for (let y = 30; y < 84; y += 9) { g.fillStyle = '#7c7c78'; g.fillRect(124, y, 264, 3); }
  for (let x = 140; x < 388; x += 22) { g.fillStyle = 'rgba(20,20,20,0.9)'; g.fillRect(x, 24, 3, 60); }
  g.fillStyle = '#b0b0aa'; g.fillRect(238, 40, 36, 26); g.fillStyle = '#6a1a14'; g.fillRect(243, 45, 26, 16);
  lens(40, 52, 30); lens(92, 52, 22); lens(472, 52, 30); lens(420, 52, 22);
  g.fillStyle = '#c8801c'; g.fillRect(14, 96, 70, 18); g.fillRect(428, 96, 70, 18);
  g.fillStyle = 'rgba(255,220,160,0.35)'; g.fillRect(16, 98, 66, 5); g.fillRect(430, 98, 66, 5);
  g.fillStyle = '#e8e6de'; g.fillRect(186, 96, 140, 28);
  text('М 208 ВК', 256, 111, 'bold 22px monospace', '#1a1a1a');
  grime(0, 0, 512, 128, 0.3);

  // sedan rear (512,0,512,128): tail clusters + plate recess
  {
    const x0 = 512;
    g.fillStyle = '#141414'; g.fillRect(x0, 0, 512, 128);
    for (const side of [0, 1]) {
      const lx = x0 + (side ? 512 - 160 : 10);
      const segs = [['#7a1a14', 60], ['#b06a14', 34], ['#d8d8d0', 24], ['#8a1a14', 32]];
      let cx = lx;
      for (const [c, w] of (side ? segs.slice().reverse() : segs)) {
        const gr = g.createLinearGradient(0, 16, 0, 100);
        gr.addColorStop(0, c); gr.addColorStop(1, '#200808');
        g.fillStyle = gr; g.fillRect(cx, 16, w - 2, 84);
        g.fillStyle = 'rgba(255,255,255,0.10)';
        for (let y = 20; y < 100; y += 6) g.fillRect(cx, y, w - 2, 2);
        cx += w;
      }
      g.strokeStyle = '#8a8a86'; g.lineWidth = 3; g.strokeRect(lx - 2, 14, 152, 88);
    }
    g.fillStyle = '#0a0a0a'; g.fillRect(x0 + 180, 40, 152, 60);
    g.fillStyle = '#e4e2da'; g.fillRect(x0 + 188, 50, 136, 36);
    text('Т 551 АР', x0 + 256, 69, 'bold 24px monospace', '#1a1a1a');
    grime(x0, 0, 512, 128, 0.35);
  }

  // truck grille (0,128,256,256): heavy vertical slots in painted steel
  {
    const y0 = 128;
    g.fillStyle = '#3c4232'; g.fillRect(0, y0, 256, 256);
    for (let x = 18; x < 240; x += 18) {
      const gr = g.createLinearGradient(x, 0, x + 10, 0);
      gr.addColorStop(0, '#050505'); gr.addColorStop(1, '#161616');
      g.fillStyle = gr; g.fillRect(x, y0 + 20, 10, 216);
      g.fillStyle = 'rgba(200,200,180,0.15)'; g.fillRect(x + 10, y0 + 20, 2, 216);
    }
    g.fillStyle = '#2a2e22'; g.fillRect(0, y0 + 118, 256, 14);
    grime(0, y0, 256, 256, 0.5);
    g.fillStyle = 'rgba(90,50,25,0.35)';
    for (let s = 0; s < 14; s++) g.fillRect(rng.next() * 256, y0 + rng.next() * 256, 3 + rng.next() * 8, 10 + rng.next() * 40);
  }

  // van front (256,128,256,256): grille slots between round lamps, plate
  {
    const x0 = 256, y0 = 128;
    g.fillStyle = '#3c4a36'; g.fillRect(x0, y0, 256, 256);
    for (let x = 80; x < 180; x += 14) { g.fillStyle = '#0a0a0a'; g.fillRect(x0 + x, y0 + 60, 8, 110); }
    lens(x0 + 40, y0 + 100, 26); lens(x0 + 216, y0 + 100, 26);
    g.fillStyle = '#c8801c'; g.fillRect(x0 + 24, y0 + 150, 32, 16); g.fillRect(x0 + 200, y0 + 150, 32, 16);
    g.fillStyle = '#e4e2da'; g.fillRect(x0 + 78, y0 + 200, 100, 22);
    text('К 730 ОН', x0 + 128, y0 + 211, 'bold 16px monospace', '#1a1a1a');
    grime(x0, y0, 256, 256, 0.45);
  }

  // plate (512,128,256,64)
  g.fillStyle = '#e4e2da'; g.fillRect(512, 128, 256, 64);
  g.strokeStyle = '#111'; g.lineWidth = 4; g.strokeRect(516, 132, 248, 56);
  text('0417 ВД', 640, 161, 'bold 40px monospace', '#151515');
  grime(512, 128, 256, 64, 0.4);

  // tail lamp (768,128,128,64)
  g.fillStyle = '#222'; g.fillRect(768, 128, 128, 64);
  {
    const gr = g.createLinearGradient(0, 132, 0, 188); gr.addColorStop(0, '#9a2016'); gr.addColorStop(1, '#3a0806');
    g.fillStyle = gr; g.fillRect(772, 132, 80, 56);
    g.fillStyle = '#b0701a'; g.fillRect(854, 132, 38, 56);
  }
  // head lamp (896,128,128,128)
  g.fillStyle = '#111'; g.fillRect(896, 128, 128, 128);
  lens(960, 192, 52);

  // bus front route board (512,192,256,64)
  g.fillStyle = '#0c0c0c'; g.fillRect(512, 192, 256, 64);
  text('12  ВОКЗАЛ', 640, 224, 'bold 30px sans-serif', '#d89a2a');
  grime(512, 192, 256, 64, 0.5);

  // bus side sign (512,256,512,64)
  g.fillStyle = '#d8d2bc'; g.fillRect(512, 256, 512, 64);
  text('ВАРДАНЕК · АВТОПАРК №2', 768, 288, 'bold 34px sans-serif', '#6a1a14');
  grime(512, 256, 512, 64, 0.5);

  // burnt front / rear (0,384) (512,384): charred, lamp sockets empty
  for (const [x0, rear] of [[0, false], [512, true]]) {
    const y0 = 384;
    g.fillStyle = '#16120f'; g.fillRect(x0, y0, 512, 128);
    drawNoise(g, rng, x0, y0, 512, 128, { alpha: 0.6, op: 'overlay', base: 12 });
    for (const lx of [60, 452]) {
      const gr = g.createRadialGradient(x0 + lx, y0 + 52, 4, x0 + lx, y0 + 52, 34);
      gr.addColorStop(0, '#020202'); gr.addColorStop(1, '#2a2420');
      g.fillStyle = gr; g.beginPath(); g.arc(x0 + lx, y0 + 52, 32, 0, Math.PI * 2); g.fill();
    }
    if (!rear) for (let y = 30; y < 84; y += 9) { g.fillStyle = 'rgba(60,50,40,0.8)'; g.fillRect(x0 + 124 + rng.next() * 20, y0 + y, 200 + rng.next() * 60, 3); }
    g.fillStyle = 'rgba(110,60,30,0.45)';
    for (let s = 0; s < 40; s++) g.fillRect(x0 + rng.next() * 512, y0 + rng.next() * 128, 4 + rng.next() * 20, 3 + rng.next() * 10);
  }

  // grille mesh strip (768,192,256,64)
  g.fillStyle = '#1a1a1a'; g.fillRect(768, 192, 256, 64);
  g.strokeStyle = '#6a6a66'; g.lineWidth = 2;
  for (let x = -64; x < 256; x += 10) {
    g.beginPath(); g.moveTo(768 + x, 192); g.lineTo(768 + x + 64, 256); g.stroke();
    g.beginPath(); g.moveTo(768 + x + 64, 192); g.lineTo(768 + x, 256); g.stroke();
  }
}
