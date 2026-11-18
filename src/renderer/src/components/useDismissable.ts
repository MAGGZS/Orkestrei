import { useEffect, useRef, type RefObject } from 'react';

type RefLike = RefObject<HTMLElement | null>;

/**
 * Dismisses popovers/dropdowns on outside pointerdown (capture phase so nodes calling
 * stopPropagation still dismiss), Escape key, or window blur (e.g. clicking into a webview).
 */
export function useDismissable(
  isOpen: boolean,
  refs: RefLike | RefLike[],
  onDismiss: () => void
): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!isOpen) return;

    const containsTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      const list = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      return list.some((r) => Boolean(r.current && r.current.contains(target)));
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (!containsTarget(e.target)) {
        onDismissRef.current();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismissRef.current();
      }
    };

    const handleBlur = () => {
      onDismissRef.current();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen]);
}
