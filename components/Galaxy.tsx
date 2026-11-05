'use client';
import { useEffect, useRef } from 'react';

// Animated spiral galaxy / Milky Way drawn on a canvas. No dependencies.
// Slow differential rotation, twinkling background stars and an occasional shooting star.
export default function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const TILT = 0.42, ROT = -0.38, cosR = Math.cos(ROT), sinR = Math.sin(ROT);
    type P = { r: number; a: number; sp: number; z: number; fill: string };
    let w = 0, h = 0, cx = 0, cy = 0, R = 0, raf = 0, last = 0;
    let disc: P[] = [];
    let bg: { x: number; y: number; z: number; p: number; s: number }[] = [];
    let shoot: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
    const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

    const build = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = innerWidth; h = innerHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = w * (w < 700 ? 0.5 : 0.68); cy = h * 0.36; R = Math.max(w, h) * 0.52;
      const n = w < 700 ? 900 : 2400;
      disc = [];
      for (let i = 0; i < n; i++) {
        const r = Math.pow(Math.random(), 1.7);
        const arm = i % 3;
        const a = arm * ((Math.PI * 2) / 3) + r * 6 + (Math.random() - 0.5) * (0.35 + 0.9 * (1 - r));
        const rgb = r < 0.12 ? '255,236,205' : r < 0.4 ? pick(['190,205,255', '255,236,205']) : r < 0.7 ? pick(['150,160,255', '200,150,255']) : pick(['120,230,215', '150,160,255']);
        const alpha = (0.15 + Math.random() * 0.6) * (1 - r * 0.5);
        disc.push({ r, a, sp: 0.00005 / (0.3 + r), z: Math.random() < 0.04 ? 2 : 1.2, fill: `rgba(${rgb},${alpha.toFixed(2)})` });
      }
      bg = Array.from({ length: w < 700 ? 120 : 280 }, () => ({ x: Math.random() * w, y: Math.random() * h, z: Math.random() < 0.1 ? 1.8 : 1, p: Math.random() * 6.28, s: 0.5 + Math.random() * 1.5 }));
    };

    const draw = (now: number, dt: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const s of bg) {
        const al = 0.25 + 0.6 * Math.abs(Math.sin(now * 0.0006 * s.s + s.p));
        ctx.fillStyle = `rgba(220,230,255,${al.toFixed(2)})`;
        ctx.fillRect(s.x, s.y, s.z, s.z);
      }
      // soft haze of the disc, then the bright core
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(ROT); ctx.scale(1, TILT);
      const haze = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      haze.addColorStop(0, 'rgba(150,130,255,.20)'); haze.addColorStop(0.5, 'rgba(90,110,255,.08)'); haze.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = haze; ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.fill();
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.28);
      core.addColorStop(0, 'rgba(255,232,190,.65)'); core.addColorStop(0.4, 'rgba(255,190,150,.2)'); core.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, R * 0.28, 0, 6.2832); ctx.fill();
      ctx.restore();
      for (const p of disc) {
        p.a += p.sp * dt;
        const x0 = Math.cos(p.a) * p.r * R, y0 = Math.sin(p.a) * p.r * R * TILT;
        ctx.fillStyle = p.fill;
        ctx.fillRect(cx + x0 * cosR - y0 * sinR, cy + x0 * sinR + y0 * cosR, p.z, p.z);
      }
      // rare shooting star
      if (!reduce && !shoot && Math.random() < 0.0012) shoot = { x: w * (0.4 + Math.random() * 0.6), y: Math.random() * h * 0.4, vx: -9, vy: 4, life: 1 };
      if (shoot) {
        ctx.strokeStyle = `rgba(255,255,255,${(shoot.life * 0.8).toFixed(2)})`; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(shoot.x, shoot.y); ctx.lineTo(shoot.x - shoot.vx * 7, shoot.y - shoot.vy * 7); ctx.stroke();
        shoot.x += shoot.vx; shoot.y += shoot.vy; shoot.life -= 0.02;
        if (shoot.life <= 0) shoot = null;
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const loop = (now: number) => { const dt = Math.min(now - (last || now), 50); last = now; draw(now, dt); raf = requestAnimationFrame(loop); };
    const start = () => { cancelAnimationFrame(raf); build(); last = 0; if (reduce) draw(0, 0); else raf = requestAnimationFrame(loop); };
    let t: any;
    const onResize = () => { clearTimeout(t); t = setTimeout(start, 150); };
    start();
    addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); removeEventListener('resize', onResize); };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="galaxy" />;
}
