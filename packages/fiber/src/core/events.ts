import { intersection } from 'lodash'
import * as THREE from 'three'
import { Object3D } from 'three'
import type { UseBoundStore } from 'zustand'
import type { Instance } from './renderer'
import type { RootState } from './store'

export interface Intersection extends THREE.Intersection {
  /** The object that the event is being delivered to. May be an ancestor of the object that was hit. */
  eventObject: THREE.Object3D
}

interface PointerCaptureTarget {
  setPointerCapture(pointerId: number): void
  releasePointerCapture(pointerId: number): void
  hasPointerCapture(pointerId: number): boolean
}

export interface IntersectionEvent<TSourceEvent> extends Intersection {
  intersections: Intersection[]
  stopped: boolean
  unprojectedPoint: THREE.Vector3
  ray: THREE.Ray
  camera: Camera
  stopPropagation: () => void
  /**
   * @deprecated in favour of nativeEvent. Please use that instead.
   */
  sourceEvent: TSourceEvent
  nativeEvent: TSourceEvent
  delta: number
  spaceX: number
  spaceY: number
  target: PointerCaptureTarget
  currentTarget: PointerCaptureTarget
}

export type Camera = THREE.OrthographicCamera | THREE.PerspectiveCamera
export type ThreeEvent<TEvent> = Omit<TEvent, 'target' | 'currentTarget'> & IntersectionEvent<TEvent>
export type DomEvent = PointerEvent | MouseEvent | WheelEvent

export type Events = {
  onClick: EventListener
  onContextMenu: EventListener
  onDoubleClick: EventListener
  onWheel: EventListener
  onPointerDown: EventListener
  onPointerUp: EventListener
  onPointerLeave: EventListener
  onPointerMove: EventListener
  onPointerCancel: EventListener
  onLostPointerCapture: EventListener
}

export type EventHandlers = {
  onClick?: (event: ThreeEvent<MouseEvent>) => void
  onContextMenu?: (event: ThreeEvent<MouseEvent>) => void
  onDoubleClick?: (event: ThreeEvent<MouseEvent>) => void
  onPointerUp?: (event: ThreeEvent<PointerEvent>) => void
  onPointerDown?: (event: ThreeEvent<PointerEvent>) => void
  onPointerOver?: (event: ThreeEvent<PointerEvent>) => void
  onPointerOut?: (event: ThreeEvent<PointerEvent>) => void
  onPointerEnter?: (event: ThreeEvent<PointerEvent>) => void
  onPointerLeave?: (event: ThreeEvent<PointerEvent>) => void
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void
  onPointerMissed?: (event: MouseEvent) => void
  onPointerCancel?: (event: ThreeEvent<PointerEvent>) => void
  onWheel?: (event: ThreeEvent<WheelEvent>) => void
}

export interface EventManager<TTarget> {
  connected: TTarget | boolean
  handlers?: Events
  connect?: (target: TTarget) => void
  disconnect?: () => void
}

export interface PointerCaptureData {
  /** The event that was used to capture.
   * In this object, `eventObject` is the capture target (possibly a parent), while `object` is the object that was actually hit.
   */
  intersection: Intersection
  domTarget: Element
}

function makeId(event: Intersection) {
  return (event.eventObject || event.object).uuid + '/' + event.index + event.instanceId
}

function isPointerEvent(event: MouseEvent): event is PointerEvent {
  return 'pointerId' in event
}

function isAncestor(ancestor: Object3D, child: Object3D | null | undefined) {
  while (child) {
    if (child === ancestor) {
      return true
    }
    child = child.parent
  }
  return false
}

/** Release pointer captures.
 * This is called by releasePointerCapture in the API, and when an object is removed. If nothing is captured, it does nothing.
 *
 * @param obj The object to release from, or undefined. If obj is not the captured object, nothing will happen. If obj is undefined, it will release whatever object is currently captured.
 * @param captureData The captureData for the current capture. If undefined, it will be fetched from capturedMap. (This is only included to reduce lookups.)
/**
 * Release pointer captures.
 * This is called by releasePointerCapture in the API, and when an object is removed.
 */
function releaseInternalPointerCapture(
  capturedMap: Map<number, PointerCaptureData>,
  obj: THREE.Object3D | undefined,
  captureData: PointerCaptureData | undefined,
  pointerId: number,
): void {
  if (!captureData) {
    captureData = capturedMap.get(pointerId)
  }
  if (!captureData) {
    // no captures
    return
  }

  if (!obj || captureData.intersection.eventObject === obj) {
    capturedMap.delete(pointerId)
    captureData.domTarget.releasePointerCapture(pointerId)
  }
}

export function removeInteractivity(store: UseBoundStore<RootState>, object: THREE.Object3D) {
  const { internal } = store.getState()
  // Removes every trace of an object from the data store
  internal.interaction = internal.interaction.filter((o) => o !== object)
  if (internal.initialHit === object) {
    internal.initialHit = undefined
  }
  internal.hovered.forEach((value, pointerId) => {
    if (value.eventObject === object || value.object === object) {
      internal.hovered.delete(pointerId)
    }
  })

  // Has the removed object captured any pointers? If so, release them.
  internal.capturedMap.forEach((captureData, pointerId) => {
    releaseInternalPointerCapture(internal.capturedMap, object, captureData, pointerId)
  })
}

export function createEvents(store: UseBoundStore<RootState>) {
  const temp = new THREE.Vector3()

  /** Sets up defaultRaycaster */
  function prepareRay(event: MouseEvent) {
    const state = store.getState()
    const { raycaster, mouse, camera, size } = state
    // https://github.com/pmndrs/react-three-fiber/pull/782
    // Events trigger outside of canvas when moved
    const customOffsets = raycaster.computeOffsets?.(event, state)
    const offsetX = customOffsets?.offsetX ?? event.offsetX
    const offsetY = customOffsets?.offsetY ?? event.offsetY
    const width = customOffsets?.width ?? size.width
    const height = customOffsets?.height ?? size.height

    mouse.set((offsetX / width) * 2 - 1, -(offsetY / height) * 2 + 1)
    raycaster.setFromCamera(mouse, camera)
  }

  /** Calculates delta */
  function calculateDistance(event: MouseEvent) {
    const { internal } = store.getState()
    const dx = event.offsetX - internal.initialClick[0]
    const dy = event.offsetY - internal.initialClick[1]
    return Math.round(Math.sqrt(dx * dx + dy * dy))
  }

  /** Returns true if an instance has a valid pointer-event registered, this excludes scroll, clicks etc */
  function filterPointerEvents(objects: THREE.Object3D[]) {
    return objects.filter((obj) =>
      ['Move', 'Over', 'Enter', 'Out', 'Leave'].some(
        (name) => (obj as unknown as Instance).__r3f?.handlers[('onPointer' + name) as keyof EventHandlers],
      ),
    )
  }

  function intersect(): Intersection[] {
    const state = store.getState()
    const { raycaster, internal } = state
    // Skip event handling when noEvents is set
    if (!raycaster.enabled) return []

    const seen = new Set<string>()

    // Allow callers to eliminate event objects
    const eventsObjects = internal.interaction

    // Intersect known handler objects and filter against duplicates
    let intersects = raycaster.intersectObjects(eventsObjects, true).filter((item) => {
      const id = makeId(item as Intersection)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })

    // https://github.com/mrdoob/three.js/issues/16031
    // Allow custom userland intersect sort order
    if (raycaster.filter) intersects = raycaster.filter(intersects, state)

    return intersects.map((intersect) => ({ ...intersect, eventObject: intersect.object }))
  }

  /**  Creates filtered intersects and returns an array of positive hits */
  function patchIntersects(intersections: Intersection[], event: MouseEvent): Intersection[] {
    const { internal } = store.getState()
    // If the interaction is captured, make the capture target part of the
    // intersect.
    let captureData: PointerCaptureData | undefined
    if (isPointerEvent(event) && (captureData = internal.capturedMap.get(event.pointerId))) {
      intersections.unshift(captureData.intersection)
    }
    return intersections
  }

  /**  Handles intersections by forwarding them to handlers */
  function handleIntersects<TEvent extends MouseEvent>(
    intersections: Intersection[],
    event: TEvent,
    delta: number,
    callback: (event: ThreeEvent<DomEvent>) => void,
  ) {
    const { raycaster, mouse, camera, internal } = store.getState()
    // If anything has been found, forward it to the event listeners
    if (intersections.length) {
      const unprojectedPoint = temp.set(mouse.x, mouse.y, 0).unproject(camera)

      const localState = { stopped: false }

      for (
        let hit = intersections[0], eventPhase: number = event.AT_TARGET;
        hit.eventObject && !localState.stopped;
        hit = { ...hit, eventObject: hit.eventObject.parent! }, eventPhase = event.BUBBLING_PHASE
      ) {
        // If the object has no handlers and is not the leaf element, there will be nothing to do.
        if (!(hit.eventObject as unknown as Instance)?.__r3f?.eventCount && eventPhase !== event.AT_TARGET) {
          continue
        }
        const hasPointerCapture = (id: number) =>
          internal.capturedMap.get(id)?.intersection.eventObject === hit.eventObject

        const setPointerCapture = (id: number) => {
          // This replaces any previous capture. If we had onPointerLost we'd call it on the old capture here.
          const captureData = {
            intersection: hit,
            domTarget: event.target as Element,
          }
          internal.capturedMap.set(id, captureData)
          internal.hovered.set(id, raycastEvent as unknown as ThreeEvent<PointerEvent>)
          // Call the original event now
          ;(event.target as Element).setPointerCapture(id)
        }

        const releasePointerCapture = (id: number) => {
          const captureData = internal.capturedMap.get(id)
          releaseInternalPointerCapture(internal.capturedMap, hit.eventObject, captureData, id)
        }

        // Add native event props
        let extractEventProps: any = {}
        // This iterates over the event's properties including the inherited ones. Native PointerEvents have most of their props as getters which are inherited, but polyfilled PointerEvents have them all as their own properties (i.e. not inherited). We can't use Object.keys() or Object.entries() as they only return "own" properties; nor Object.getPrototypeOf(event) as that *doesn't* return "own" properties, only inherited ones.
        for (let prop in event) {
          let property = event[prop as keyof (MouseEvent | PointerEvent | WheelEvent)]
          // Only copy over atomics, leave functions alone as these should be
          // called as event.nativeEvent.fn()
          if (typeof property !== 'function') extractEventProps[prop] = property
        }

        let raycastEvent: ThreeEvent<TEvent> = {
          ...hit,
          ...extractEventProps,
          eventPhase,
          spaceX: mouse.x,
          spaceY: mouse.y,
          intersections,
          stopped: localState.stopped,
          delta,
          unprojectedPoint,
          ray: raycaster.ray,
          camera: camera,
          // Hijack stopPropagation, which just sets a flag
          stopPropagation: () => {
            raycastEvent.stopped = localState.stopped = true
          },
          // there should be a distinction between target and currentTarget
          target: { hasPointerCapture, setPointerCapture, releasePointerCapture },
          currentTarget: { hasPointerCapture, setPointerCapture, releasePointerCapture },
          sourceEvent: event, // deprecated
          nativeEvent: event,
        }

        // Call subscribers
        callback(raycastEvent)
        // Event bubbling may be interrupted by stopPropagation
        if (localState.stopped) break
      }
    }
    return intersections
  }

  function cancelPointer(pointerId: number, hits: Intersection[]) {
    const { internal } = store.getState()
    const hoveredEvent = internal.hovered.get(pointerId)

    if (!hoveredEvent) {
      // nothing to cancel
      return
    }

    // When no objects were hit or the the hovered object wasn't the top hit object
    // we call onPointerOut and delete the object from the hovered-elements map
    if (
      !hits.length ||
      hits[0].object !== hoveredEvent.object ||
      hits[0].index !== hoveredEvent.index ||
      hits[0].instanceId !== hoveredEvent.instanceId
    ) {
      internal.hovered.delete(pointerId)
      for (let eventObject = hoveredEvent.object; eventObject; eventObject = eventObject.parent!) {
        const instance = (eventObject as unknown as Instance).__r3f
        const handlers = instance?.handlers
        if (handlers && (handlers.onPointerOut || handlers.onPointerLeave)) {
          // Clear out intersects, they are outdated by now
          const data: ThreeEvent<DomEvent> = { ...hoveredEvent, eventObject, intersections: hits || [] }
          handlers.onPointerOut?.(data as ThreeEvent<PointerEvent>)
          handlers.onPointerLeave?.(data as ThreeEvent<PointerEvent>)
        }
      }
    }
  }

  const handlePointer = (name: string) => {
    // Deal with cancelation
    switch (name) {
      case 'onPointerLeave':
      case 'onPointerCancel':
        return (ev: PointerEvent) => cancelPointer(ev.pointerId, [])
      case 'onLostPointerCapture':
        return (ev: DomEvent) => {
          const { internal } = store.getState()
          if ('pointerId' in ev && !internal.capturedMap.has(ev.pointerId)) {
            // If the object event interface had onLostPointerCapture, we'd call it here on every
            // object that's getting removed.
            internal.capturedMap.delete(ev.pointerId)
            // If the object event interface had onLostPointerCapture, we'd call it here.
            releaseInternalPointerCapture(
              store.getState().internal.capturedMap,
              undefined,
              undefined,
              (ev as PointerEvent).pointerId,
            )
          }
        }
    }

    // Any other pointer goes here ...
    return (event: MouseEvent) => {
      const { onPointerMissed, internal, scene } = store.getState()

      if (scene.autoUpdate) scene.updateMatrixWorld()
      prepareRay(event)
      internal.lastEvent.current = event

      // Get fresh intersects
      const isPointerMove = name === 'onPointerMove'
      const isClickEvent = name === 'onClick' || name === 'onContextMenu' || name === 'onDoubleClick'
      const hits = patchIntersects(intersect(), event)
      const delta = isClickEvent ? calculateDistance(event) : 0

      // Save initial coordinates on pointer-down
      if (name === 'onPointerDown') {
        internal.initialClick = [event.offsetX, event.offsetY]
        // NB hits will be empty on a miss
        internal.initialHit = hits[0]?.object
      }

      // If a click yields no results, pass it back to the user as a miss
      // Missed events have to come first in order to establish user-land side-effect clean up
      if (isClickEvent && !hits.length) {
        if (delta <= 2) {
          pointerMissed(event, internal.interaction)
          if (onPointerMissed) onPointerMissed(event)
        }
      }

      let isEnteringAndOrLeaving = false
      if (isPointerMove) {
        const pointerId = (event as PointerEvent).pointerId
        // Take care of unhover
        cancelPointer(pointerId, hits)
        const previousHover = internal.hovered.get(pointerId)
        if (previousHover?.object !== hits[0]?.object) {
          isEnteringAndOrLeaving = true
        }
      }

      handleIntersects(hits, event, delta, (data: ThreeEvent<DomEvent>) => {
        const eventObject = data.eventObject
        const instance = (eventObject as unknown as Instance).__r3f
        const handlers = instance?.handlers

        if (isPointerMove) {
          // If it's a pointer move, the input event must be a PointerEvent
          const pointerEvent = data as ThreeEvent<PointerEvent>

          const pointerId = (event as PointerEvent).pointerId
          // When enter or out is present take care of hover-state
          if (isEnteringAndOrLeaving) {
            // If the object wasn't previously hovered, book it and call its handler
            if (data.eventPhase === data.AT_TARGET) {
              internal.hovered.set(pointerId, pointerEvent)
            }
            handlers.onPointerOver?.(pointerEvent)
            handlers.onPointerEnter?.(pointerEvent)
          } else {
            // If it was previously hovered, call onPointerMove
            handlers.onPointerMove?.(pointerEvent)
          }
        } else {
          // All other events ...
          const handler = handlers[name as keyof EventHandlers] as (event: ThreeEvent<PointerEvent>) => void
          if (handler) {
            // Forward all events back to their respective handlers with the exception of click events,
            // which must use the initial target
            if (
              (name !== 'onClick' && name !== 'onContextMenu' && name !== 'onDoubleClick') ||
              internal.initialHit === data.object
            ) {
              // Missed events have to come first
              pointerMissed(
                event,
                internal.interaction.filter((object) => !isAncestor(object, internal.initialHit)),
              )
              // Now call the handler
              handler(data as ThreeEvent<PointerEvent>)
            }
          } else {
            // Trigger onPointerMissed on all elements that have pointer over/out handlers, but not click and weren't hit
            if (isClickEvent && internal.initialHit === eventObject) {
              pointerMissed(
                event,
                internal.interaction.filter((object) => internal.initialHit !== object),
              )
            }
          }
        }
      })
    }
  }

  function pointerMissed(event: MouseEvent, objects: THREE.Object3D[]) {
    objects.forEach((object: THREE.Object3D) =>
      (object as unknown as Instance).__r3f?.handlers.onPointerMissed?.(event),
    )
  }

  return { handlePointer }
}
