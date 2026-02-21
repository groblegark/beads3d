// Custom shaders for beads3d visual effects
import * as THREE from 'three';

// --- Fresnel Glow Shader ---
// Creates a rim-lighting effect: transparent at center, glowing at edges.
// Used for the outer glow shell around each node.
export function createFresnelMaterial(color, { opacity = 0.4, power = 2.0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(color) },
      opacity: { value: opacity },
      power: { value: power },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float opacity;
      uniform float power;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), power);
        gl_FragColor = vec4(glowColor, fresnel * opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

// --- Pulsing Ring Shader ---
// Animated pulsing with color cycling for in-progress nodes.
export function createPulseRingMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ringColor: { value: new THREE.Color(color) },
      time: { value: 0 },
      pulseCycle: { value: 4.0 }, // bd-b3ujw: controllable pulse speed
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 ringColor;
      uniform float time;
      uniform float pulseCycle;
      varying vec2 vUv;
      void main() {
        // Intermittent pulse: brief flash every ~Ns, fades quickly (bd-s9b4v, bd-b3ujw)
        float cycle = mod(time, pulseCycle);
        float pulse = smoothstep(0.0, 0.3, cycle) * smoothstep(1.0, 0.3, cycle) * 0.3;
        // Soft edges along the torus cross-section
        float dist = abs(vUv.y - 0.5) * 2.0;
        float softEdge = smoothstep(1.0, 0.3, dist);
        gl_FragColor = vec4(ringColor, pulse * softEdge);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// --- Background Star Field ---
// Creates a GPU particle system of tiny stars for depth and atmosphere.
export function createStarField(count = 2000, radius = 600) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Distribute in a sphere shell (inner radius 200, outer radius)
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 200 + Math.random() * (radius - 200);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    sizes[i] = 0.5 + Math.random() * 1.5;
    alphas[i] = 0.1 + Math.random() * 0.4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      color: { value: new THREE.Color(0x6688aa) },
      twinkleSpeed: { value: 1.0 }, // bd-b3ujw: controllable twinkle speed
    },
    vertexShader: `
      attribute float size;
      attribute float alpha;
      varying float vAlpha;
      uniform float time;
      uniform float twinkleSpeed;
      void main() {
        vAlpha = alpha;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        // Subtle twinkle: size oscillates per-particle (bd-b3ujw: speed controllable)
        float twinkle = 1.0 + 0.3 * sin(time * 1.5 * twinkleSpeed + position.x * 0.1);
        gl_PointSize = size * twinkle * (300.0 / -mvPos.z);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      varying float vAlpha;
      void main() {
        // Circular soft point
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.1, d);
        gl_FragColor = vec4(color, a * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.userData.isStarField = true;
  return points;
}

// --- Selection Pulse Shader ---
// A bright, pulsing ring for the selected node (replaces basic material).
// Set `visible` uniform to 1.0 to show, 0.0 to hide.
export function createSelectionRingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ringColor: { value: new THREE.Color(0x4a9eff) },
      time: { value: 0 },
      visible: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 ringColor;
      uniform float time;
      uniform float visible;
      varying vec2 vUv;
      void main() {
        if (visible < 0.5) discard;
        float pulse = 0.5 + 0.3 * sin(time * 4.0);
        // Animated sweep around the ring
        float sweep = sin(vUv.x * 6.2832 + time * 2.0) * 0.5 + 0.5;
        float dist = abs(vUv.y - 0.5) * 2.0;
        float softEdge = smoothstep(1.0, 0.2, dist);
        float alpha = pulse * softEdge * (0.6 + 0.4 * sweep);
        gl_FragColor = vec4(ringColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// --- Update all shader uniforms ---
// Call this in the animation loop to advance time-based effects.
export function updateShaderTime(scene, time) {
  scene.traverse(obj => {
    if (obj.material && obj.material.uniforms && obj.material.uniforms.time) {
      obj.material.uniforms.time.value = time;
    }
  });
}
