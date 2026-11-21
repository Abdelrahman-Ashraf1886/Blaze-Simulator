/**
 * Shared materials for the frame and part models. Created once and reused, so a
 * build with hundreds of meshes still has a handful of materials (and shaders).
 *
 * Carbon fibre uses a 2×2 twill weave drawn on a canvas (no image files). The
 * extruded frame and part shapes have UVs in metres, so the texture repeats every
 * WEAVE_M of surface.
 */
import {
  CanvasTexture,
  Color,
  DoubleSide,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
} from 'three'

/** Size of one repeat of the weave texture: 8 tows of ~1.5 mm. */
const WEAVE_M = 0.012

function weaveTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const n = 8 // tows per repeat
  const px = 16 // pixels per tow
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n * px
  const g = canvas.getContext('2d')
  if (!g) return null
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      // 2×2 twill: the over/under pattern shifts by one tow per row.
      const warp = ((i + j) >> 1) % 2 === 0
      const grad = warp ? g.createLinearGradient(i * px, 0, (i + 1) * px, 0) : g.createLinearGradient(0, j * px, 0, (j + 1) * px)
      grad.addColorStop(0, '#08090a')
      grad.addColorStop(0.5, warp ? '#23262b' : '#181a1e')
      grad.addColorStop(1, '#08090a')
      g.fillStyle = grad
      g.fillRect(i * px, j * px, px, px)
    }
  const t = new CanvasTexture(canvas)
  t.wrapS = t.wrapT = RepeatWrapping
  t.repeat.set(1 / WEAVE_M, 1 / WEAVE_M)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  return t
}

let cache: ReturnType<typeof build> | null = null

function build() {
  const weave = weaveTexture()
  const std = (color: string, metalness: number, roughness: number, extra: Partial<MeshStandardMaterial> = {}) =>
    Object.assign(new MeshStandardMaterial({ color: new Color(color), metalness, roughness }), extra)
  return {
    carbon: new MeshPhysicalMaterial({
      color: weave ? '#ffffff' : '#25282d',
      map: weave,
      metalness: 0, // resin and fibre are dielectric; any metalness glares white
      roughness: 0.5,
      // A satin clearcoat: glossy enough to read as resin, but the room lights
      // must not wash the weave out to white at grazing angles.
      clearcoat: 0.2,
      clearcoatRoughness: 0.4,
      envMapIntensity: 0.3,
    }),
    aluminium: std('#c3c9d0', 0.95, 0.32),
    aluminiumDark: std('#5b636c', 0.9, 0.38),
    anodizedBlack: std('#1d2024', 0.6, 0.4),
    anodizedAccent: std('#c9692f', 0.65, 0.35),
    steel: std('#9ba3ab', 1, 0.22),
    copper: std('#b8743d', 0.9, 0.3),
    plasticBlack: std('#1b1e22', 0, 0.6),
    plasticGrey: std('#4d535b', 0, 0.5, { side: DoubleSide }),
    plasticWhite: std('#dcd9cf', 0, 0.55),
    plasticYellow: std('#d6a52f', 0, 0.5),
    pcb: std('#1d3b2c', 0.1, 0.6),
    chip: std('#121417', 0.2, 0.5),
    gold: std('#d1a64c', 1, 0.3),
    shrinkBlue: std('#2f5d8a', 0, 0.5),
    label: std('#2f5d8a', 0.05, 0.45),
    lens: new MeshPhysicalMaterial({ color: '#d9dde2', roughness: 0.15, transmission: 0, clearcoat: 1, metalness: 0 }),
    ledGreen: new MeshStandardMaterial({ color: '#5dab8b', emissive: '#5dab8b', emissiveIntensity: 1.2 }),
    ledBlue: new MeshStandardMaterial({ color: '#4f8fd8', emissive: '#4f8fd8', emissiveIntensity: 1.2 }),
    carbonBlade: new MeshPhysicalMaterial({
      color: weave ? '#ffffff' : '#25282d',
      map: weave,
      metalness: 0,
      roughness: 0.45,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      side: DoubleSide,
    }),
    bladeTip: std('#c9692f', 0.1, 0.4, { side: DoubleSide }),
  } satisfies Record<string, Material>
}

/** The shared material set (built on first use, in the renderer). */
export function materials() {
  return (cache ??= build())
}
export type Materials = ReturnType<typeof materials>
