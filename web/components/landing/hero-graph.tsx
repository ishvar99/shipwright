"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The hero visual IS the product: a code graph acting out a session on loop — a search pulse
 * sweeps the modules lighting nodes in the four evidence hues, ten candidates hold while the
 * rest recede, one function locks on. The recorded demo below then shows the real thing.
 *
 * Craft notes, because the obvious implementation looks cheap:
 * - Nodes are drawn by a small shader, not textured sprites. Sprites with soft radial falloff
 *   read as out-of-focus dust; a procedural disc stays crisp at any size or DPR, and a shader
 *   affords per-node size so hub functions are visibly bigger.
 * - Topology is modules with hubs — satellites calling into a hub, plus sparse hub-to-hub
 *   imports. That is what a call graph looks like; nearest-neighbour wiring looks like lint.
 * - Composition: modules sit on an elliptical ring so the centre of frame is deliberately
 *   empty for the headline, instead of fogging it evenly.
 *
 * The hero panel carries its own `.dark` scope, so blending is always additive.
 */

const CYCLE_S = 10;
const SCAN_END = 3.4;
const HOLD_END = 5.6;
const LOCK_END = 8.0;

// smoothstep() is undefined for edge0 >= edge1, so every falloff is written ascending and
// inverted. It renders fine on some GPUs either way, which is exactly why it is a trap.
const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float near = 1.0 - smoothstep(10.0, 38.0, -mv.z);
    vAlpha = aAlpha * mix(0.30, 1.0, near);
    gl_PointSize = aSize * uPixelRatio * (14.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uHalo;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float core = 1.0 - smoothstep(0.28, 0.44, d);
    // On light the halo becomes haze rather than glow, so it is dialled almost out.
    float halo = (1.0 - smoothstep(0.10, 0.5, d)) * uHalo;
    gl_FragColor = vec4(vColor, min(1.0, core + halo) * vAlpha);
  }
`;

type Palette = { base: THREE.Color; ink: THREE.Color; evidence: THREE.Color[]; accent: THREE.Color };

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function readPalette(host: HTMLElement): Palette {
  const css = getComputedStyle(host);
  const probe = document.createElement("span");
  host.appendChild(probe);
  const resolve = (variable: string) => {
    // color-mix()/oklch() need the browser to resolve to a computed rgb.
    probe.style.color = css.getPropertyValue(variable).trim() || "#888";
    return new THREE.Color(getComputedStyle(probe).color);
  };
  const palette = {
    base: resolve("--muted"),
    ink: resolve("--fg"),
    evidence: ["--evidence-text", "--evidence-graph", "--evidence-dense", "--evidence-path"].map(resolve),
    accent: resolve("--accent"),
  };
  probe.remove();
  return palette;
}

export default function HeroGraph() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const narrow = matchMedia("(max-width: 760px)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      return; // no WebGL: the panel's own gradient carries the hero
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
    camera.position.z = 20;

    // ---- topology: modules on a ring, each a hub with satellites ---------------------------
    const rand = seeded(11);
    const MODULES = narrow ? 7 : 11;
    const CLEAR = narrow ? 6 : 9;
    // The headline occupies a wide, short box mid-frame. Exclude a slightly larger box, so
    // "outside the exclusion" implies "outside the headline" by containment — an elliptical
    // boundary cuts through the box's diagonals and leaks nodes into the text.
    // Displacement follows the axis with room to spare: sideways in landscape (dense left and
    // right, clear middle), vertically in portrait (bands above and below).
    const BX = narrow ? 6.6 : 9.0;
    const BY = narrow ? 5.2 : 4.0;
    const XMUL = narrow ? 0.85 : 1.4;
    const YMUL = narrow ? 1.25 : 0.5;

    const clearCentre = (v: THREE.Vector3) => {
      if (Math.abs(v.x) > BX || Math.abs(v.y) > BY) return v;
      if (narrow) v.y = (v.y >= 0 ? 1 : -1) * BY * (1.02 + rand() * 0.6);
      else v.x = (v.x >= 0 ? 1 : -1) * BX * (1.02 + rand() * 0.55);
      return v;
    };

    type Node = { p: THREE.Vector3; module: number; hub: boolean; evidence: number; size: number };
    const nodes: Node[] = [];
    const hubIndex: number[] = [];

    for (let m = 0; m < MODULES; m += 1) {
      // Golden-angle placement keeps the ring irregular rather than a clock face.
      const angle = m * 2.399 + rand() * 0.4;
      const spread = CLEAR + rand() * 5;
      const centre = clearCentre(
        new THREE.Vector3(
          Math.cos(angle) * spread * XMUL,
          Math.sin(angle) * spread * YMUL,
          (rand() - 0.5) * 14,
        ),
      );
      hubIndex.push(nodes.length);
      nodes.push({ p: centre, module: m, hub: true, evidence: Math.floor(rand() * 4), size: 18 });

      const satellites = narrow ? 12 + Math.floor(rand() * 8) : 18 + Math.floor(rand() * 14);
      for (let i = 0; i < satellites; i += 1) {
        // Shell distribution: satellites orbit the hub instead of clumping on top of it.
        const r = 1.1 + rand() * 2.1;
        const t = rand() * Math.PI * 2;
        const u = rand() * 2 - 1;
        const ring = Math.sqrt(1 - u * u);
        nodes.push({
          p: clearCentre(
            new THREE.Vector3(
              centre.x + r * ring * Math.cos(t) * 1.15,
              centre.y + r * ring * Math.sin(t),
              centre.z + r * u,
            ),
          ),
          module: m,
          hub: false,
          evidence: Math.floor(rand() * 4),
          size: 7 + rand() * 4,
        });
      }
    }

    const COUNT = nodes.length;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    const alphas = new Float32Array(COUNT);
    nodes.forEach((n, i) => {
      positions.set([n.p.x, n.p.y, n.p.z], i * 3);
      sizes[i] = n.size;
      alphas[i] = 1;
    });

    // Edges: satellites call into their hub; hubs import from two other modules.
    const edgePairs: [number, number][] = [];
    nodes.forEach((n, i) => {
      if (!n.hub) edgePairs.push([i, hubIndex[n.module]]);
    });
    for (let m = 0; m < MODULES; m += 1) {
      for (const other of [(m + 1) % MODULES, (m + 4) % MODULES]) {
        if (other !== m) edgePairs.push([hubIndex[m], hubIndex[other]]);
      }
    }

    // The session: one target function and the shortlist around it.
    const focusModule = 2 % MODULES;
    const inFocus = nodes.map((n, i) => (n.module === focusModule && !n.hub ? i : -1)).filter((i) => i >= 0);
    const target = inFocus[Math.floor(inFocus.length / 2)] ?? hubIndex[focusModule];
    const candidates = new Set<number>([target, hubIndex[focusModule]]);
    for (const i of inFocus) if (candidates.size < 10) candidates.add(i);

    const radius = nodes.map((n) => n.p.length());
    const maxR = Math.max(...radius);
    const baseSize = Float32Array.from(sizes);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));

    // Own attribute names, not three's `color` + vertexColors: no reliance on which
    // declarations the library happens to inject into a ShaderMaterial.
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPixelRatio: { value: renderer.getPixelRatio() },
        uHalo: { value: 0.28 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.Points(geometry, material));

    // Edges carry per-vertex colour, so a lit node visibly lights its calls.
    const edgePositions = new Float32Array(edgePairs.length * 6);
    const edgeColors = new Float32Array(edgePairs.length * 6);
    edgePairs.forEach(([a, b], i) => {
      edgePositions.set([...nodes[a].p.toArray(), ...nodes[b].p.toArray()], i * 6);
    });
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    let palette = readPalette(el);
    // Additive blending glows on dark but only ADDS brightness on light, where it washes to
    // nothing. Light draws normally: crisp ink instead of glow.
    let light = !el.closest(".dark");
    const applyTheme = () => {
      palette = readPalette(el);
      light = !el.closest(".dark");
      const blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      material.blending = blending;
      material.uniforms.uHalo.value = light ? 0.06 : 0.28;
      material.needsUpdate = true;
      edgeMaterial.blending = blending;
      edgeMaterial.opacity = light ? 0.16 : 0.6;
      edgeMaterial.needsUpdate = true;
      paint(reduced ? SCAN_END * 0.55 : elapsed);
    };

    // ---- the loop --------------------------------------------------------------------------
    const scratch = new THREE.Color();

    function paint(t: number) {
      const phase = t % CYCLE_S;
      const wave = (phase / SCAN_END) * maxR * 1.15;

      for (let i = 0; i < COUNT; i += 1) {
        const isCandidate = candidates.has(i);
        // On light the base is ink at low alpha; --muted is too pale to register at all.
        let alpha = light ? (nodes[i].hub ? 0.45 : 0.26) : nodes[i].hub ? 0.9 : 0.5;
        if (light) scratch.copy(palette.ink);
        else scratch.copy(palette.base).multiplyScalar(0.5);
        sizes[i] = baseSize[i];

        if (phase < SCAN_END) {
          // A shell expanding from the centre; nodes flare in their evidence hue as it passes.
          const hit = Math.exp(-((wave - radius[i]) ** 2) / 1.4);
          scratch.lerp(palette.evidence[nodes[i].evidence], Math.min(1, hit * 1.4));
          alpha += hit * (light ? 0.8 : 1);
        } else if (phase < LOCK_END) {
          const settle = Math.min(1, (phase - SCAN_END) / 0.7);
          if (isCandidate) {
            scratch.lerp(palette.evidence[nodes[i].evidence], 0.95);
            alpha = light ? 1 : 1.15;
          } else {
            // The rest genuinely recede, so the shortlist is unmistakable. On light, alpha
            // alone does it — darkening the colour would make them stand out more, not less.
            alpha *= 1 - 0.72 * settle;
            if (!light) scratch.multiplyScalar(1 - 0.3 * settle);
          }
        } else {
          const release = (phase - LOCK_END) / (CYCLE_S - LOCK_END);
          if (isCandidate) {
            scratch.lerp(palette.evidence[nodes[i].evidence], 0.95 * (1 - release));
            alpha = (light ? 1 : 1.15) - 0.3 * release;
          } else {
            alpha *= 0.28 + 0.72 * release;
          }
        }

        if (i === target) {
          const lock =
            phase < HOLD_END
              ? 0
              : phase < LOCK_END
                ? Math.min(1, (phase - HOLD_END) / 0.6)
                : Math.max(0, 1 - (phase - LOCK_END) / 1.4);
          scratch.lerp(palette.accent, lock);
          alpha = Math.max(alpha, lock * 1.4);
          sizes[i] = baseSize[i] + lock * (20 + 4 * Math.sin(t * 5));
        }

        colors.set([scratch.r, scratch.g, scratch.b], i * 3);
        alphas[i] = Math.min(light ? 1 : 1.6, alpha);
      }

      // Edges inherit a dimmed blend of their endpoints. Dimming means multiplying toward
      // black, which on light reads as *more* prominent — so light keeps them at full colour
      // and lets the material's flat opacity hold them back instead.
      for (let e = 0; e < edgePairs.length; e += 1) {
        const [a, b] = edgePairs[e];
        for (let slot = 0; slot < 2; slot += 1) {
          const n = slot === 0 ? a : b;
          const o = e * 6 + slot * 3;
          const f = light ? 1 : 0.3 * Math.min(1, alphas[n]);
          edgeColors[o] = colors[n * 3] * f;
          edgeColors[o + 1] = colors[n * 3 + 1] * f;
          edgeColors[o + 2] = colors[n * 3 + 2] * f;
        }
      }

      geometry.getAttribute("aColor").needsUpdate = true;
      geometry.getAttribute("aSize").needsUpdate = true;
      geometry.getAttribute("aAlpha").needsUpdate = true;
      edgeGeometry.getAttribute("color").needsUpdate = true;
      renderer.render(scene, camera);
    }

    // ---- lifecycle -------------------------------------------------------------------------
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
      elapsed += Math.min(clock.getDelta(), 0.05);
      // Sway, not spin: a full rotation would drag modules across the headline.
      scene.rotation.y = Math.sin(elapsed * 0.05) * 0.2 + pointer.x * 0.05;
      scene.rotation.x = Math.sin(elapsed * 0.037) * 0.07 + pointer.y * 0.035;
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
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      camera.aspect = width / height;
      // Pull back when the frame is tall, so the ring still frames the copy.
      camera.position.z = camera.aspect < 1.1 ? 27 : 20;
      camera.updateProjectionMatrix();
      if (!running) paint(reduced ? SCAN_END * 0.55 : elapsed);
    });
    resize.observe(el);

    const visible = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()));
    visible.observe(el);
    const onTab = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onTab);
    window.addEventListener("pointermove", onPointer, { passive: true });

    const themeWatch = new MutationObserver(applyTheme);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    applyTheme(); // also paints, so the first frame is never empty

    return () => {
      stop();
      resize.disconnect();
      visible.disconnect();
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", onTab);
      window.removeEventListener("pointermove", onPointer);
      geometry.dispose();
      edgeGeometry.dispose();
      material.dispose();
      edgeMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={host} aria-hidden className="sw-hero-canvas" />;
}
