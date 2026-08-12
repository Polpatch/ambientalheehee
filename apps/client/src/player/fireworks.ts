import * as THREE from 'three';

type Burst = {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  velocities: Float32Array;
  age: number;
  lifetime: number;
};

const PALETTE = [0xffb54a, 0xff6b6b, 0x72d6c9, 0x9ba8ff, 0xf8ecd0, 0xd98bff];

export class FireworksScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bursts: Burst[] = [];
  private readonly clock = new THREE.Clock();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private frame = 0;
  private burstCount = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera.position.z = 8;
    this.scene.add(this.createStars());
    this.resize();
    window.addEventListener('resize', this.resize);
    this.frame = requestAnimationFrame(this.render);
  }

  burst(seed = Math.random()) {
    const count = this.reducedMotion ? 42 : 180;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const origin = new THREE.Vector3((seed - 0.5) * 7, 0.4 + Math.random() * 2.7, (Math.random() - 0.5) * 1.5);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = origin.x;
      positions[offset + 1] = origin.y;
      positions[offset + 2] = origin.z;
      const direction = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
      ).normalize();
      const speed = this.reducedMotion ? 0.25 : 1.1 + Math.random() * 2.5;
      velocities[offset] = direction.x * speed;
      velocities[offset + 1] = direction.y * speed;
      velocities[offset + 2] = direction.z * speed;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: PALETTE[this.burstCount % PALETTE.length]!,
      size: this.reducedMotion ? 0.055 : 0.085,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    this.bursts.push({ points, velocities, age: 0, lifetime: this.reducedMotion ? 1.1 : 2.2 });
    this.burstCount += 1;
    this.canvas.dataset.bursts = String(this.burstCount);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resize);
    for (const burst of this.bursts) this.disposeBurst(burst);
    this.bursts.length = 0;
    this.scene.traverse((object) => {
      if (object instanceof THREE.Points) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.renderer.dispose();
  }

  private readonly resize = () => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly render = () => {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    for (let burstIndex = this.bursts.length - 1; burstIndex >= 0; burstIndex -= 1) {
      const burst = this.bursts[burstIndex]!;
      burst.age += delta;
      const positions = burst.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let index = 0; index < positions.count; index += 1) {
        const offset = index * 3;
        burst.velocities[offset + 1] = burst.velocities[offset + 1]! - 0.85 * delta;
        positions.array[offset] = Number(positions.array[offset]) + burst.velocities[offset]! * delta;
        positions.array[offset + 1] = Number(positions.array[offset + 1]) + burst.velocities[offset + 1]! * delta;
        positions.array[offset + 2] = Number(positions.array[offset + 2]) + burst.velocities[offset + 2]! * delta;
      }
      positions.needsUpdate = true;
      burst.points.material.opacity = Math.max(0, 1 - burst.age / burst.lifetime);
      if (burst.age >= burst.lifetime) {
        this.disposeBurst(burst);
        this.bursts.splice(burstIndex, 1);
      }
    }
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.render);
  };

  private createStars() {
    const count = 420;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 20;
      positions[index * 3 + 1] = (Math.random() - 0.5) * 12;
      positions[index * 3 + 2] = -2 - Math.random() * 8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x708783, size: 0.025, transparent: true, opacity: 0.62 }));
  }

  private disposeBurst(burst: Burst) {
    this.scene.remove(burst.points);
    burst.points.geometry.dispose();
    burst.points.material.dispose();
  }
}
