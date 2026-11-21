import { Object3D } from 'three'

// The renderer shares the engine's world frame: right-handed, Z-up, metres
// (+X forward, +Y left). Every camera and object created after this import
// treats +Z as up. Import this module before creating any three.js object.
Object3D.DEFAULT_UP.set(0, 0, 1)
