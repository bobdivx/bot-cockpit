import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bot, Room, RoomKind, Signal, Team } from '../shared/types';
import { STATUS_LABEL } from './format';

export type CampusSnapshot = {
  rooms: Room[];
  teams: Team[];
  bots: Bot[];
  signals: Signal[];
  demo: boolean;
};

type Motion = 'still' | 'typing' | 'present' | 'away' | 'blocked' | 'frozen';

type Actor = {
  id: string;
  root: THREE.Group;
  body: THREE.Group;
  screen: THREE.Mesh;
  bubble: THREE.Sprite;
  motion: Motion;
  baseY: number;
  baseScale: number;
  home: THREE.Vector3;
  phase: number;
};

type Mote = { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number };

const PASTELS = [
  '#8eb7ff',
  '#f3d56a',
  '#c4b2ff',
  '#ffb08f',
  '#8fd4c8',
  '#f4b4cf',
  '#a8d98f',
  '#f0c36a',
];

function validHex(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#c9ad8e';
}

function pastel(hex: string): THREE.Color {
  return new THREE.Color(validHex(hex)).lerp(new THREE.Color('#ffffff'), 0.62);
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function motionOf(bot: Bot): Motion {
  if (bot.quiet || bot.status === 'offline') return 'still';
  if (bot.stale) return 'frozen';
  if (bot.status === 'working') return 'typing';
  if (bot.status === 'blocked') return 'blocked';
  if (bot.status === 'away') return 'away';
  return 'present';
}

function bubbleText(bot: Bot, motion: Motion): string {
  if (motion === 'frozen') return 'Signal ancien';
  if (motion === 'still') return 'Aucun signal';
  if (motion === 'blocked') return 'Bloqué';
  return STATUS_LABEL[bot.status];
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bubbleTexture(text: string, motion: Motion): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  const fill =
    motion === 'typing'
      ? '#e5f6ef'
      : motion === 'blocked'
        ? '#fde8e4'
        : motion === 'frozen'
          ? '#f8ecd8'
          : motion === 'still'
            ? '#eef1f4'
            : '#ffffff';
  ctx.fillStyle = fill;
  roundRect(ctx, 16, 18, 480, 110, 40);
  ctx.fill();
  ctx.fillStyle = motion === 'still' ? '#8b93a0' : '#1c2430';
  ctx.font = '600 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 22), 256, 74);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function wallLabel(text: string): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.clearRect(0, 0, 1024, 256);
  ctx.fillStyle = '#2a3340';
  ctx.font = '600 120px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 22), 24, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 0.85),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  return mesh;
}

export class CampusView {
  readonly ok: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private readonly actors: Actor[] = [];
  private readonly roomCenters = new Map<string, THREE.Vector3>();
  private readonly motes: Mote[] = [];
  private readonly seen = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly goalPos = new THREE.Vector3();
  private readonly goalTarget = new THREE.Vector3();
  private readonly iso = new THREE.Vector3(10, 11, 10);
  private courier: THREE.Group | null = null;
  private key = '';
  private primed = false;
  private reduced = false;
  private aiming = false;
  private disposed = false;
  private raf = 0;
  private lastFrame = performance.now();
  private elapsed = 0;
  private pointerDown = { x: 0, y: 0 };
  private onSelect: (id: string) => void;
  private resizeObserver: ResizeObserver;
  private selectedId: string | null = null;
  private goalZoom = 1;

  constructor(host: HTMLElement, onSelect: (id: string) => void, reduced: boolean) {
    this.onSelect = onSelect;
    this.reduced = reduced;
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      this.ok = false;
      this.renderer = null as unknown as THREE.WebGLRenderer;
      this.camera = null as unknown as THREE.OrthographicCamera;
      this.controls = null as unknown as OrbitControls;
      this.resizeObserver = new ResizeObserver(() => undefined);
      return;
    }
    this.renderer = renderer;
    this.ok = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, reduced ? 1 : 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#e7edf3');
    this.scene.add(this.root);
    const aspect = 1;
    this.camera = new THREE.OrthographicCamera(-8 * aspect, 8 * aspect, 8, -8, 0.1, 80);
    this.camera.position.copy(this.iso);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableRotate = false;
    this.controls.enableDamping = !reduced;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.touches.ONE = THREE.TOUCH.PAN;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    this.controls.minZoom = 0.45;
    this.controls.maxZoom = 3.6;
    this.controls.target.set(0, 0.4, 0);
    this.goalPos.copy(this.camera.position);
    this.goalTarget.copy(this.controls.target);
    this.addLights();
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (this.controls) this.controls.enableDamping = !reduced;
    this.renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, reduced ? 1 : 1.5));
    if (this.courier) this.courier.visible = !reduced;
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const actor of this.actors) {
      const ring = actor.root.getObjectByName('ring');
      if (ring) ring.visible = actor.id === id;
    }
  }

  setSnapshot(snapshot: CampusSnapshot): void {
    if (!this.ok) return;
    const key = [
      snapshot.demo ? '1' : '0',
      ...snapshot.rooms.map((room) => `${room.id}:${room.name}:${room.kind}:${room.teamId}`),
      ...snapshot.bots.map(
        (bot) =>
          `${bot.id}:${bot.name}:${bot.roomId}:${bot.teamId}:${motionOf(bot) === 'away' ? 'a' : 'd'}`,
      ),
    ].join('|');
    if (key !== this.key) {
      this.key = key;
      this.rebuild(snapshot);
    } else {
      this.applyMotions(snapshot.bots);
    }
    this.noteSignals(snapshot.signals);
    if (this.courier)
      this.courier.visible = snapshot.demo && !this.reduced && this.actors.length >= 2;
  }

  resetCamera(): void {
    const centers = [...this.roomCenters.values()];
    const focus = new THREE.Vector3();
    if (centers.length > 0) {
      for (const center of centers) focus.add(center);
      focus.multiplyScalar(1 / centers.length);
    }
    let span = 4;
    for (const center of centers) span = Math.max(span, focus.distanceTo(center));
    const zoom = centers.length <= 1 ? 1.72 : THREE.MathUtils.clamp(1.28 - span / 16, 0.58, 1.08);
    this.focusAt(focus, zoom);
  }

  enterSelected(): void {
    const actor = this.actors.find((item) => item.id === this.selectedId) ?? this.actors[0];
    if (!actor) {
      this.resetCamera();
      return;
    }
    this.focusAt(actor.home, 2.85);
  }

  focusRoom(id: string): void {
    const center = this.roomCenters.get(id);
    if (!center) return;
    this.focusAt(center, 2.05);
    const occupant = this.actors.find((actor) => actor.root.parent?.userData.roomId === id);
    if (occupant) this.onSelect(occupant.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    if (!this.ok) return;
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.clearRoot();
    this.renderer.dispose();
  }

  private focusAt(point: THREE.Vector3, zoom: number): void {
    this.goalTarget.set(point.x, 0.8, point.z);
    this.goalPos.copy(this.goalTarget).add(this.iso);
    this.goalZoom = zoom;
    this.aiming = true;
    if (this.reduced) this.snapCamera();
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xf7fbff, 0xd5dde6, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.35);
    sun.position.set(8, 16, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 50;
    sun.shadow.camera.left = -22;
    sun.shadow.camera.right = 22;
    sun.shadow.camera.top = 22;
    sun.shadow.camera.bottom = -22;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
  }

  private rebuild(snapshot: CampusSnapshot): void {
    const cameraPos = this.camera.position.clone();
    const target = this.controls.target.clone();
    const zoom = this.camera.zoom;
    const had = this.actors.length > 0 || this.roomCenters.size > 0;
    this.clearRoot();
    const rooms = [...snapshot.rooms]
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .slice(0, 8);
    const plates = rooms.length > 0 ? rooms : [];
    plates.forEach((room, index) => {
      const spot = this.place(index, plates.length);
      this.roomCenters.set(room.id, spot.clone());
      const team = snapshot.teams.find((item) => item.id === room.teamId);
      const group = this.buildRoom(room, spot, pastel(team?.accent ?? '#d5dde6').getStyle());
      this.root.add(group);
      const occupants = snapshot.bots.filter((bot) => bot.roomId === room.id).slice(0, 4);
      for (let seat = 0; seat < occupants.length; seat += 1) {
        const bot = occupants[seat];
        if (bot) group.add(this.buildActor(bot, seat, occupants.length, false));
      }
      if (occupants.length === 0) group.add(this.emptyDesk());
    });
    if (plates.length === 0) {
      const spot = new THREE.Vector3();
      this.root.add(this.buildEmptyPlate(spot));
      this.roomCenters.set('empty', spot.clone());
    }
    const loose = snapshot.bots
      .filter((bot) => !bot.roomId || !this.roomCenters.has(bot.roomId))
      .slice(0, 4);
    loose.forEach((bot, index) => {
      const spot = new THREE.Vector3(-2 + index * 1.4, 0, 4.2);
      this.root.add(this.buildActor(bot, 0, 1, true, spot));
    });
    if (plates.length >= 2) this.root.add(this.pingPongAt(0, 0));
    if (snapshot.demo && snapshot.bots.length >= 2) this.root.add(this.buildCourier());
    this.root.updateWorldMatrix(true, true);
    for (const actor of this.actors) actor.root.getWorldPosition(actor.home);
    if (this.reduced) this.pose(0);
    if (!had) this.resetCamera();
    else {
      this.camera.position.copy(cameraPos);
      this.controls.target.copy(target);
      this.camera.zoom = zoom;
      this.camera.updateProjectionMatrix();
      this.goalPos.copy(cameraPos);
      this.goalTarget.copy(target);
      this.goalZoom = zoom;
    }
    this.setSelected(this.selectedId);
  }

  private place(index: number, count: number): THREE.Vector3 {
    const cols = count <= 2 ? Math.max(count, 1) : count <= 4 ? 2 : 3;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const rows = Math.ceil(count / cols);
    return new THREE.Vector3((col - (cols - 1) / 2) * 12, 0, (row - (rows - 1) / 2) * 10);
  }

  private buildEmptyPlate(spot: THREE.Vector3): THREE.Group {
    const group = new THREE.Group();
    group.position.copy(spot);
    group.add(this.slab('#e7eef5'));
    const label = wallLabel('Aucune salle');
    label.position.set(0, 1.4, 0);
    group.add(label);
    return group;
  }

  private slab(tint: string): THREE.Group {
    const group = new THREE.Group();
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(9.2, 0.26, 7.2),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.92 }),
    );
    top.position.y = 0.13;
    top.receiveShadow = true;
    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(9.45, 0.62, 7.45),
      new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.8 }),
    );
    skirt.position.y = -0.24;
    skirt.receiveShadow = true;
    group.add(top, skirt);
    return group;
  }

  private buildRoom(room: Room, spot: THREE.Vector3, tint: string): THREE.Group {
    const group = new THREE.Group();
    group.position.copy(spot);
    group.userData.roomId = room.id;
    group.add(this.slab(tint));
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xf7f8fa, roughness: 0.9 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(9.2, 3.1, 0.12), wallMat);
    back.position.set(0, 1.7, -3.5);
    back.castShadow = true;
    back.receiveShadow = true;
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.1, 7.2), wallMat);
    side.position.set(-4.5, 1.7, 0);
    side.castShadow = true;
    side.receiveShadow = true;
    const title = wallLabel(room.name);
    title.position.set(0.4, 2.35, -3.4);
    group.add(
      back,
      side,
      title,
      this.plant(-3.4, -2.4),
      this.clock(2.6),
      this.rug(),
      this.bookPile(),
    );
    this.addKindFurniture(group, room.kind);
    group.traverse((obj) => {
      obj.userData.roomId = room.id;
    });
    return group;
  }

  private addKindFurniture(group: THREE.Group, kind: RoomKind): void {
    if (kind === 'revue' || kind === 'labo') group.add(this.shelf());
    if (kind === 'salon') group.add(this.pingPongAt(2.2, 1.4));
    if (kind === 'atelier') group.add(this.rack());
    if (kind === 'diffusion') {
      const board = this.wallScreen();
      board.position.set(-1.8, 1.7, -3.4);
      group.add(board);
    }
  }

  private shelf(): THREE.Group {
    const group = new THREE.Group();
    const frame = new THREE.MeshStandardMaterial({ color: 0xfbfcfd, roughness: 0.7 });
    const caseBox = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.7, 0.32), frame);
    caseBox.position.set(1.6, 1.2, -2.5);
    group.add(caseBox);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 7; col += 1) {
        const book = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.38, 0.22),
          new THREE.MeshStandardMaterial({
            color: PASTELS[(row * 3 + col) % PASTELS.length],
            roughness: 0.5,
          }),
        );
        book.position.set(0.7 + col * 0.26, 0.6 + row * 0.48, -2.5);
        group.add(book);
      }
    }
    return group;
  }

  private pingPongAt(x: number, z: number): THREE.Group {
    const group = this.pingPong();
    group.position.set(x, 0, z);
    return group;
  }

  private pingPong(): THREE.Group {
    const group = new THREE.Group();
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.06, 0.95),
      new THREE.MeshStandardMaterial({ color: 0x7dcec2, roughness: 0.45 }),
    );
    top.position.set(0, 0.72, 0);
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.6, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x1d2430 }),
    );
    leg.position.set(0, 0.4, 0);
    const net = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.18, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    net.position.set(0, 0.84, 0);
    group.add(top, leg, net);
    return group;
  }

  private rack(): THREE.Group {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 1.5, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.5 }),
    );
    body.position.set(3.5, 1.05, -2.6);
    group.add(body);
    for (let index = 0; index < 4; index += 1) {
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.06, 0.02),
        new THREE.MeshStandardMaterial({
          color: index % 2 ? 0x7dcec2 : 0xf3d56a,
          emissive: index % 2 ? 0x1c6d62 : 0x8a5712,
          emissiveIntensity: 0.8,
        }),
      );
      led.position.set(3.5, 0.55 + index * 0.28, -2.38);
      group.add(led);
    }
    return group;
  }

  private wallScreen(): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.8),
      new THREE.MeshStandardMaterial({
        color: 0x1c2430,
        emissive: 0x31486b,
        emissiveIntensity: 0.5,
      }),
    );
  }

  private rug(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.03, 2.4),
      new THREE.MeshStandardMaterial({ color: 0xf6f0e6, roughness: 0.96 }),
    );
    mesh.position.set(0, 0.28, 0.75);
    mesh.receiveShadow = true;
    return mesh;
  }

  private bookPile(): THREE.Group {
    const group = new THREE.Group();
    const colors = [0xf4b4cf, 0x8eb7ff, 0xf3d56a];
    for (let index = 0; index < colors.length; index += 1) {
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.07, 0.32),
        new THREE.MeshStandardMaterial({ color: colors[index], roughness: 0.55 }),
      );
      book.position.set(3.15, 0.34 + index * 0.08, 1.55);
      book.rotation.y = (index - 1) * 0.18;
      book.castShadow = true;
      group.add(book);
    }
    return group;
  }

  private plant(x: number, z: number): THREE.Group {
    const group = new THREE.Group();
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.14, 0.22, 12),
      new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.6 }),
    );
    pot.position.set(x, 0.4, z);
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x8fd4a8, roughness: 0.55 }),
    );
    leaf.position.set(x, 0.78, z);
    leaf.castShadow = true;
    group.add(pot, leaf);
    return group;
  }

  private clock(x: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 20),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
    );
    mesh.position.set(x, 2.15, -3.4);
    return mesh;
  }

  private emptyDesk(): THREE.Group {
    const group = new THREE.Group();
    group.add(this.deskAt(0, 0.2));
    group.add(this.chairAt(0, 1.05));
    return group;
  }

  private deskAt(x: number, z: number): THREE.Group {
    const group = new THREE.Group();
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 0.08, 0.7),
      new THREE.MeshStandardMaterial({ color: 0xfbfcfd, roughness: 0.45 }),
    );
    top.position.set(x, 0.74, z);
    top.castShadow = true;
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.06, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xd5dde6, roughness: 0.6 }),
    );
    leg.position.set(x, 0.62, z);
    group.add(top, leg);
    return group;
  }

  private chairAt(x: number, z: number): THREE.Group {
    const group = new THREE.Group();
    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.08, 0.46),
      new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.45 }),
    );
    seat.position.set(x, 0.46, z);
    seat.castShadow = true;
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.42, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.45 }),
    );
    back.position.set(x, 0.7, z + 0.2);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.32, 8),
      new THREE.MeshStandardMaterial({ color: 0x8b93a0 }),
    );
    pole.position.set(x, 0.28, z);
    group.add(seat, back, pole);
    return group;
  }

  private buildActor(
    bot: Bot,
    index: number,
    total: number,
    loose: boolean,
    looseSpot?: THREE.Vector3,
  ): THREE.Group {
    const motion = motionOf(bot);
    const away = motion === 'away';
    const root = new THREE.Group();
    const span = Math.max(total, 1);
    const x = loose ? 0 : (index - (span - 1) / 2) * 2.15;
    const seatZ = away ? 2.15 : 1.05;
    const deskZ = 0.15;
    if (loose && looseSpot) root.position.copy(looseSpot);
    else root.position.set(x, 0, 0);
    if (!away) {
      root.add(this.deskAt(0, deskZ));
      root.add(this.monitorAt(0, deskZ - 0.28));
    }
    root.add(this.chairAt(0, away ? seatZ : seatZ));
    const body = this.makeBody(bot.name, motion);
    body.scale.setScalar(1.55);
    body.position.set(0, away ? 1.15 : 1.32, seatZ - 0.02);
    root.add(body);
    const screen = root.getObjectByName('screen');
    const bubble = this.makeBubble(bubbleText(bot, motion), motion);
    bubble.position.set(0, 2.72, seatZ);
    root.add(bubble);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 28),
      new THREE.MeshBasicMaterial({
        color: 0x8eb7ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.28, seatZ);
    ring.name = 'ring';
    ring.visible = false;
    root.add(ring);
    root.traverse((obj) => {
      obj.userData.botId = bot.id;
    });
    this.actors.push({
      id: bot.id,
      root,
      body,
      screen: screen instanceof THREE.Mesh ? screen : new THREE.Mesh(),
      bubble,
      motion,
      baseY: body.position.y,
      baseScale: body.scale.x,
      home: new THREE.Vector3(),
      phase: (hashName(bot.id) % 100) / 16,
    });
    return root;
  }

  private monitorAt(x: number, z: number): THREE.Group {
    const group = new THREE.Group();
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.62, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.4 }),
    );
    frame.position.set(x, 1.12, z);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 0.46),
      new THREE.MeshStandardMaterial({
        color: 0xd7fff2,
        emissive: 0x1c6d62,
        emissiveIntensity: 0.45,
        roughness: 0.35,
      }),
    );
    screen.position.set(x, 1.12, z + 0.04);
    screen.name = 'screen';
    const neck = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.18, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x8b93a0 }),
    );
    neck.position.set(x, 0.78, z);
    group.add(frame, screen, neck);
    return group;
  }

  private makeBody(name: string, motion: Motion): THREE.Group {
    const group = new THREE.Group();
    const color = new THREE.Color(PASTELS[hashName(name) % PASTELS.length]);
    const material = new THREE.MeshStandardMaterial({
      color: motion === 'still' ? color.clone().lerp(new THREE.Color('#c5ced8'), 0.55) : color,
      roughness: 0.42,
      metalness: 0.02,
    });
    const variant = hashName(name) % 5;
    let mesh: THREE.Mesh;
    if (variant === 0) mesh = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.78, 0.78), material);
    else if (variant === 1) mesh = new THREE.Mesh(new THREE.SphereGeometry(0.46, 24, 16), material);
    else if (variant === 2) mesh = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.9, 20), material);
    else if (variant === 3) mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), material);
    else mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.36, 8, 16), material);
    mesh.castShadow = true;
    group.add(mesh);
    const eyes: Array<[number, number, number, number]> =
      variant === 0
        ? [
            [-0.14, 0.08, 0.41, 0.06],
            [0.14, 0.08, 0.41, 0.06],
          ]
        : variant === 1
          ? [
              [-0.13, 0.1, 0.42, 0.055],
              [0.13, 0.1, 0.42, 0.055],
            ]
          : variant === 2
            ? [
                [-0.07, 0.14, 0.16, 0.048],
                [0.07, 0.14, 0.16, 0.048],
              ]
            : variant === 3
              ? [
                  [-0.1, 0.08, 0.33, 0.05],
                  [0.1, 0.08, 0.33, 0.05],
                ]
              : [
                  [-0.09, 0.16, 0.31, 0.05],
                  [0.09, 0.16, 0.31, 0.05],
                ];
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1d2430 });
    for (const [x, y, z, radius] of eyes) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), eyeMat);
      eye.position.set(x, y, z);
      group.add(eye);
    }
    return group;
  }

  private makeBubble(text: string, motion: Motion): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: bubbleTexture(text, motion),
        transparent: true,
        depthWrite: false,
      }),
    );
    sprite.scale.set(2.05, 0.64, 1);
    sprite.renderOrder = 2;
    return sprite;
  }

  private buildCourier(): THREE.Group {
    const group = new THREE.Group();
    const card = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.08, 0.48),
      new THREE.MeshStandardMaterial({ color: 0xff7a59, roughness: 0.4 }),
    );
    card.castShadow = true;
    group.add(card);
    group.name = 'courier';
    this.courier = group;
    return group;
  }

  private applyMotions(bots: Bot[]): void {
    for (const bot of bots) {
      const actor = this.actors.find((item) => item.id === bot.id);
      if (!actor) continue;
      const motion = motionOf(bot);
      if (motion === actor.motion) continue;
      actor.motion = motion;
      const material = actor.screen.material as THREE.MeshStandardMaterial;
      if (material.emissive && material.color) {
        material.color.set(motion === 'still' ? 0xc5d0d8 : 0x9ee7d4);
        material.emissive.set(
          motion === 'blocked' ? 0x8e3830 : motion === 'frozen' ? 0xc4842a : 0x1c6d62,
        );
        material.emissiveIntensity = motion === 'still' ? 0.05 : 0.5;
      }
      const map = bubbleTexture(bubbleText(bot, motion), motion);
      const spriteMat = actor.bubble.material as THREE.SpriteMaterial;
      spriteMat.map?.dispose();
      spriteMat.map = map;
    }
  }

  private noteSignals(signals: Signal[]): void {
    if (!this.primed) {
      for (const signal of signals) this.seen.add(signal.id);
      this.primed = true;
      return;
    }
    for (const signal of signals) {
      if (this.seen.has(signal.id)) continue;
      this.seen.add(signal.id);
      if (!this.reduced && signal.botId) this.spawnMote(signal.botId);
    }
  }

  private spawnMote(botId: string): void {
    const actor = this.actors.find((item) => item.id === botId);
    if (!actor) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x8eb7ff }),
    );
    const from = new THREE.Vector3(0, 1.4, 0);
    const to = actor.home.clone().setY(1.6);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.motes.push({ mesh, from, to, t: 0 });
  }

  private pose(time: number): void {
    for (const actor of this.actors) {
      const { motion } = actor;
      const lively = motion === 'typing' || motion === 'present' || motion === 'away';
      const wave = this.reduced
        ? 0
        : Math.sin(time * (motion === 'typing' ? 5.5 : 1.8) + actor.phase);
      const hop =
        motion === 'typing' ? 0.72 : motion === 'present' ? 0.22 : motion === 'away' ? 0.1 : 0;
      const pulse = motion === 'typing' && !this.reduced ? 1 + Math.abs(wave) * 0.14 : 1;
      actor.body.position.y = actor.baseY + (lively ? Math.abs(wave) * hop : 0);
      actor.body.scale.setScalar(actor.baseScale * pulse);
      actor.body.rotation.y =
        motion === 'frozen' || motion === 'still' ? 0 : wave * (motion === 'typing' ? 1.15 : 0.35);
      actor.bubble.position.y = 2.72 + Math.abs(wave) * (motion === 'typing' ? 0.42 : 0.08);
      const material = actor.screen.material as THREE.MeshStandardMaterial;
      if (material.emissive && motion === 'typing' && !this.reduced) {
        const flash = Math.sin(time * 8 + actor.phase) > 0;
        material.color.set(flash ? 0xf7fffb : 0x163832);
        material.emissive.set(flash ? 0xd8fff3 : 0x0e2e2a);
        material.emissiveIntensity = flash ? 2.6 : 0.15;
      }
      actor.root.getWorldPosition(actor.home);
    }
    if (this.reduced || !this.courier || this.actors.length < 2) return;
    const cursor = (time * 0.55) % this.actors.length;
    const index = Math.floor(cursor);
    const next = (index + 1) % this.actors.length;
    const from = this.actors[index]?.home;
    const to = this.actors[next]?.home;
    if (!from || !to || !this.courier) return;
    this.courier.position.lerpVectors(from, to, cursor - index);
    this.courier.position.y = 3.5 + Math.sin((cursor - index) * Math.PI) * 0.8;
    this.courier.rotation.y = time;
  }

  private animateMotes(dt: number): void {
    for (let index = this.motes.length - 1; index >= 0; index -= 1) {
      const mote = this.motes[index];
      if (!mote) continue;
      mote.t += dt / 1.1;
      mote.mesh.position.lerpVectors(mote.from, mote.to, Math.min(1, mote.t));
      if (mote.t >= 1) {
        this.scene.remove(mote.mesh);
        mote.mesh.geometry.dispose();
        (mote.mesh.material as THREE.Material).dispose();
        this.motes.splice(index, 1);
      }
    }
  }

  private animateCamera(dt: number): void {
    if (!this.aiming) return;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 3.4);
    this.camera.position.lerp(this.goalPos, k);
    this.controls.target.lerp(this.goalTarget, k);
    this.camera.zoom = THREE.MathUtils.lerp(this.camera.zoom, this.goalZoom, k);
    this.camera.updateProjectionMatrix();
    if (this.camera.position.distanceTo(this.goalPos) < 0.04) this.aiming = false;
  }

  private snapCamera(): void {
    this.camera.position.copy(this.goalPos);
    this.controls.target.copy(this.goalTarget);
    this.camera.zoom = this.goalZoom;
    this.camera.updateProjectionMatrix();
    this.aiming = false;
  }

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.elapsed += this.reduced ? 0 : dt;
    this.pose(this.elapsed);
    if (!this.reduced) this.animateMotes(dt);
    this.animateCamera(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private resize = (): void => {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    const aspect = width / height;
    const view = 6.2;
    this.camera.left = -view * aspect;
    this.camera.right = view * aspect;
    this.camera.top = view;
    this.camera.bottom = -view;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 6)
      return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const botId = node.userData.botId;
        if (typeof botId === 'string') {
          this.onSelect(botId);
          this.setSelected(botId);
          this.enterSelected();
          return;
        }
        node = node.parent;
      }
    }
  };

  private clearRoot(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const material = mesh.material;
      if (Array.isArray(material)) for (const item of material) materials.add(item);
      else if (material) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) {
      const mapped = material as THREE.MeshStandardMaterial;
      mapped.map?.dispose();
      material.dispose();
    }
    this.root.clear();
    this.actors.length = 0;
    this.roomCenters.clear();
    this.courier = null;
  }
}
