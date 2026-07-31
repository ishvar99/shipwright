"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The hero visual IS the product: a code graph — functions as nodes, calls as edges — acting
 * out a session on loop. A search pulse sweeps the constellation lighting nodes in the four
 * evidence hues, the candidates hold while the rest recede, and one node locks on with the
 * accent glow. The recorded demo below then shows the real thing.
 *
 * Discipline: colours come from the live CSS tokens (theme-aware, re-reads on toggle); the
 * loop pauses off-screen and in hidden tabs; reduced motion gets one static frame; no WebGL
 * renders nothing and the CSS glow carries the hero alone.
 */

const CYCLE_S = 9;
const SCAN_END = 3.2;
const NARROW_END = 5.2;
const LOCK_END = 7.4;

type Palette = { base: THREE.Color; evidence: THREE.Color[]; accent: THREE.Color };

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  const resolve = (variable: string) => {
    // color-mix()/oklch() need the browser to resolve to a computed rgb.
    probe.style.color = css.getPropertyValue(variable).trim() || "#888";
    return new THREE.Color(getComputedStyle(probe).color);
  };
  const palette = {
    base: resolve("--muted"),
    evidence: ["--evidence-text", "--evidence-graph", "--evidence-dense", "--evidence-path"].map(resolve),
    accent: resolve("--accent"),
  };
  probe.remove();
  return palette;
}

/** Soft round sprite so points render as glows, not squares. */
function dotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export default function HeroGraph() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      return; // no WebGL: the CSS glow carries the hero
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.z = 15;

    // --- the graph: clustered nodes, edges to near neighbours -----------------------------
    const rand = seeded(7);
    const small = matchMedia("(max-width: 700px)").matches;
    const COUNT = small ? 240 : 420;
    const positions = new Float32Array(COUNT * 3);
    const nodes: THREE.Vector3[] = [];
    const clusters = Array.from({ length: 7 }, () =>
      new THREE.Vector3((rand() - 0.5) * 14, (rand() - 0.5) * 8, (rand() - 0.5) * 8),
    );
    for (let i = 0; i < COUNT; i += 1) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      const v = new THREE.Vector3(
        c.x + (rand() + rand() - 1) * 3.4,
        c.y + (rand() + rand() - 1) * 2.6,
        c.z + (rand() + rand() - 1) * 3.0,
      );
      nodes.push(v);
      positions.set([v.x, v.y, v.z], i * 3);
    }
    const evidenceOf = new Uint8Array(COUNT).map(() => Math.floor(rand() * 4));
    const radius = nodes.map((v) => v.length());
    const maxR = Math.max(...radius);

    // Candidates and the target: a believable "top ten", biased toward one cluster.
    const target = nodes.reduce((best, v, i) => (v.distanceTo(clusters[2]) < nodes[best].distanceTo(clusters[2]) ? i : best), 0);
    const candidates = new Set<number>([target]);
    const byDist = [...nodes.keys()].sort(
      (a, b) => nodes[a].distanceTo(nodes[target]) - nodes[b].distanceTo(nodes[target]),
    );
    for (const i of byDist.slice(1, 24)) if (candidates.size < 10 && rand() > 0.4) candidates.add(i);

    const colors = new Float32Array(COUNT * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: small ? 0.34 : 0.3,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.Points(geometry, material));

    // Edges: each node to its two nearest neighbours, drawn once, breathing via opacity.
    const edgePositions: number[] = [];
    for (let i = 0; i < COUNT; i += 1) {
      const near = [...nodes.keys()]
        .filter((j) => j !== i)
        .sort((a, b) => nodes[a].distanceTo(nodes[i]) - nodes[b].distanceTo(nodes[i]))
        .slice(0, 2);
      for (const j of near) {
        if (j > i) edgePositions.push(...nodes[i].toArray(), ...nodes[j].toArray());
      }
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    // The locked node: a sprite that swells with the accent when the search lands.
    const targetSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: dotTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    targetSprite.position.copy(nodes[target]);
    scene.add(targetSprite);

    let palette = readPalette();
    const applyTheme = () => {
      palette = readPalette();
      edgeMaterial.color.copy(palette.base);
      targetSprite.material.color.copy(palette.accent);
      if (reduced) paint(SCAN_END * 0.6); // keep the static frame in the new theme
    };

    const scratch = new THREE.Color();
    function paint(t: number) {
      const phase = t % CYCLE_S;
      for (let i = 0; i < COUNT; i += 1) {
        scratch.copy(palette.base).multiplyScalar(0.5);
        if (phase < SCAN_END) {
          // The pulse: an expanding shell that flashes each node's evidence hue as it passes.
          const wave = (phase / SCAN_END) * maxR * 1.2;
          const hit = Math.exp(-((wave - radius[i]) ** 2) / 0.5);
          scratch.lerp(palette.evidence[evidenceOf[i]], Math.min(1, hit));
        } else if (phase < LOCK_END) {
          // Narrow: candidates hold their evidence colour, the rest recede.
          const settle = Math.min(1, (phase - SCAN_END) / 0.8);
          if (candidates.has(i)) scratch.lerp(palette.evidence[evidenceOf[i]], 0.85);
          else scratch.multiplyScalar(1 - 0.45 * settle);
        } else {
          const release = (phase - LOCK_END) / (CYCLE_S - LOCK_END);
          if (candidates.has(i)) scratch.lerp(palette.evidence[evidenceOf[i]], 0.85 * (1 - release));
        }
        colors.set([scratch.r, scratch.g, scratch.b], i * 3);
      }
      geometry.getAttribute("color").needsUpdate = true;

      // Lock-on: the accent swell during the third beat.
      const lock =
        phase < NARROW_END ? 0 : phase < LOCK_END ? Math.min(1, (phase - NARROW_END) / 0.7) : Math.max(0, 1 - (phase - LOCK_END) / 1.2);
      targetSprite.material.opacity = lock;
      const swell = 1 + 0.25 * Math.sin(t * 4);
      targetSprite.scale.setScalar(1.6 * lock * swell + 0.001);
      edgeMaterial.opacity = 0.08 + 0.06 * lock;

      renderer.render(scene, camera);
    }

    // --- lifecycle -------------------------------------------------------------------------
    const pointer = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointer.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };

    let raf = 0;
    let running = false;
    const clock = new THREE.Clock();
    let elapsed = 0;
    const loop = () => {
      elapsed += clock.getDelta();
      scene.rotation.y = elapsed * 0.04 + pointer.x * 0.08;
      scene.rotation.x = pointer.y * 0.05;
      paint(elapsed);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || reduced) return;
      running = true;
      clock.start();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      clock.stop();
      cancelAnimationFrame(raf);
    };

    const resize = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      if (reduced) paint(SCAN_END * 0.6);
    });
    resize.observe(el);

    const visible = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()));
    visible.observe(el);
    const onTab = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onTab);
    window.addEventListener("pointermove", onPointer, { passive: true });

    const themeWatch = new MutationObserver(applyTheme);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    applyTheme();
    if (reduced) paint(SCAN_END * 0.6); // one still frame, mid-scan: alive but motionless

    return () => {
      stop();
      resize.disconnect();
      visible.disconnect();
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", onTab);
      window.removeEventListener("pointermove", onPointer);
      geometry.dispose();
      edgeGeometry.dispose();
      material.map?.dispose();
      material.dispose();
      edgeMaterial.dispose();
      targetSprite.material.map?.dispose();
      targetSprite.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={host} aria-hidden className="sw-hero-canvas" />;
}
