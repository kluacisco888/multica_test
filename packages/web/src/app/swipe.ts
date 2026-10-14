import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';

/** How far a row must travel before letting go triggers its action. */
export function swipeThreshold(rowWidth: number): number {
  return Math.max(72, rowWidth * 0.25);
}

/** Finger travel before deciding between a sideways swipe and a vertical scroll. */
const SLOP = 10;

type Gesture = { id: number; x: number; y: number; state: 'pending' | 'swiping' | 'scrolling' };

/**
 * Touch swipe on a 任务 row (spec 用户故事 108): drag sideways and let go past
 * the threshold — right runs `onRight`, left runs `onLeft`; short swipes
 * spring back. Only touch input swipes (mouse keeps click / drag-and-drop),
 * and vertical moves are left to the browser (`touch-action: pan-y`).
 */
export function useSwipe({ onLeft, onRight }: { onLeft: () => void; onRight: () => void }) {
  const gesture = useRef<Gesture | null>(null);
  const swiped = useRef(false);
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);

  function reset() {
    gesture.current = null;
    setSettling(true);
    setOffset(0);
  }

  const handlers = {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      swiped.current = false;
      gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, state: 'pending' };
      setSettling(false);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId || g.state === 'scrolling') return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (g.state === 'pending') {
        if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)) {
          g.state = 'swiping';
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } else if (Math.abs(dy) > SLOP) {
          g.state = 'scrolling';
          return;
        } else {
          return;
        }
      }
      setOffset(dx);
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      if (g.state === 'swiping') {
        swiped.current = true;
        const dx = e.clientX - g.x;
        const threshold = swipeThreshold(e.currentTarget.getBoundingClientRect().width);
        reset();
        if (dx >= threshold) onRight();
        else if (dx <= -threshold) onLeft();
        return;
      }
      gesture.current = null;
    },
    onPointerCancel() {
      if (gesture.current) reset();
    },
    /** A swipe ends with a click on whatever is under the finger: swallow it. */
    onClickCapture(e: MouseEvent<HTMLElement>) {
      if (!swiped.current) return;
      swiped.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return { offset, settling, handlers };
}
