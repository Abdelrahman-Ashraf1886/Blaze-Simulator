import type { Component } from '../../../electron/ipc/component-fields'
import { useComponents } from '@/stores/components'
import type { ComponentIndex } from './links'

const cache = new WeakMap<object, ComponentIndex>()

/** Library components by id, built once per list (the store replaces the list on change). */
export function componentIndex(list: readonly Component[]): ComponentIndex {
  let idx = cache.get(list)
  if (!idx) {
    idx = Object.fromEntries(list.map((c) => [c.id, c])) as ComponentIndex
    cache.set(list, idx)
  }
  return idx
}

export const useComponentIndex = (): ComponentIndex => componentIndex(useComponents((s) => s.components))
