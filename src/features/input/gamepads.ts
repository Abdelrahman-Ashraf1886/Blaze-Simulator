export interface DeviceHandle {
  readonly id: string
  readonly index: number
  readonly connection: number
}

interface ButtonSample {
  readonly value: number
  readonly pressed: boolean
}

interface DeviceSample {
  readonly id: string
  readonly index: number
  readonly mapping: string
  readonly axes: readonly number[]
  readonly buttons: readonly ButtonSample[]
  readonly connected: boolean
}

export interface InputDevice extends DeviceHandle {
  readonly mapping: '' | 'standard'
  readonly axes: readonly number[]
  readonly buttons: readonly ButtonSample[]
}

type SourceEvent =
  | { type: 'connect' }
  | { type: 'disconnect'; id: string; index: number }
  | { type: 'blur' }

export interface GamepadSource {
  read(): ArrayLike<DeviceSample | null>
  requestFrame(callback: () => void): number
  cancelFrame(frame: number): void
  listen(callback: (event: SourceEvent) => void): () => void
}

type InputEvent = 'sample' | 'connect' | 'disconnect' | 'blur'
export const NO_DEVICES: readonly InputDevice[] = []

function sameSamples(previous: InputDevice, sample: DeviceSample, mapping: InputDevice['mapping']) {
  return previous.mapping === mapping
    && previous.axes.length === sample.axes.length
    && sample.axes.every((value, i) => Object.is(value, previous.axes[i]))
    && previous.buttons.length === sample.buttons.length
    && sample.buttons.every((button, i) =>
      Object.is(button.value, previous.buttons[i]?.value) && button.pressed === previous.buttons[i]?.pressed)
}

export function createGamepadService(source: GamepadSource) {
  let devices = NO_DEVICES
  let nextConnection = 0
  let pendingFrame: number | undefined
  let unlisten: (() => void) | undefined
  const listeners = new Set<(event: InputEvent) => void>()

  function emit(event: InputEvent) {
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) listener(event)
    }
  }

  function schedule() {
    if (listeners.size && pendingFrame === undefined) pendingFrame = source.requestFrame(poll)
  }

  function poll() {
    pendingFrame = undefined
    const previous = devices
    devices = Array.from(source.read()).flatMap((sample) => {
      if (!sample?.connected) return []
      const existing = previous.find((device) => device.index === sample.index && device.id === sample.id)
      const mapping = sample.mapping === 'standard' ? 'standard' : ''
      if (existing && sameSamples(existing, sample, mapping)) return [existing]
      return [{
        id: sample.id, index: sample.index, connection: existing?.connection ?? nextConnection++,
        mapping, axes: [...sample.axes], buttons: sample.buttons.map(({ value, pressed }) => ({ value, pressed })),
      }]
    })
    if (previous.length === devices.length && previous.every((device, i) => device === devices[i])) {
      devices = previous
    } else {
      const disconnected = previous.some((device) => !devices.some((next) => next.connection === device.connection))
      const connected = devices.some((device) => !previous.some((old) => old.connection === device.connection))
      if (disconnected) emit('disconnect')
      if (connected) emit('connect')
      if (!disconnected && !connected) emit('sample')
    }
    schedule()
  }

  function onSourceEvent(event: SourceEvent) {
    if (event.type === 'blur') emit('blur')
    if (event.type === 'connect') schedule()
    if (event.type === 'disconnect') {
      const remaining = devices.filter((device) => device.index !== event.index || device.id !== event.id)
      if (remaining.length !== devices.length) {
        devices = remaining
        emit('disconnect')
      }
    }
  }

  return {
    getDevices: () => devices,
    subscribe(listener: (event: InputEvent) => void) {
      const subscription = (event: InputEvent) => listener(event)
      listeners.add(subscription)
      if (listeners.size === 1) {
        unlisten = source.listen(onSourceEvent)
        schedule()
      }
      return () => {
        if (!listeners.delete(subscription) || listeners.size) return
        unlisten?.()
        unlisten = undefined
        if (pendingFrame !== undefined) source.cancelFrame(pendingFrame)
        pendingFrame = undefined
        devices = NO_DEVICES
      }
    },
  }
}
