import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function MobileTableScroll({ children, label, className = '' }: {
  children: ReactNode
  label: string
  className?: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [canMoveLeft, setCanMoveLeft] = useState(false)
  const [canMoveRight, setCanMoveRight] = useState(false)

  const updatePosition = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    setCanMoveLeft(viewport.scrollLeft > 2)
    setCanMoveRight(viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 2)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    updatePosition()
    const observer = new ResizeObserver(updatePosition)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
  }, [children, updatePosition])

  const move = (direction: -1 | 1) => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollBy({ left: direction * Math.max(240, viewport.clientWidth * 0.8), behavior: 'smooth' })
  }

  return (
    <div className={`min-w-0 ${className}`}>
      {(canMoveLeft || canMoveRight) && (
        <div className="mobile-table-controls sticky top-14 z-20 flex items-center justify-between gap-3 border-b bg-card/95 px-3 py-2 backdrop-blur md:hidden">
          <span className="min-w-0 text-xs text-muted-foreground">Swipe columns or use arrows</span>
          <div className="flex shrink-0 gap-2">
            <button type="button" aria-label={`Show previous ${label} columns`} disabled={!canMoveLeft} onClick={() => move(-1)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border bg-background disabled:opacity-35"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" aria-label={`Show more ${label} columns`} disabled={!canMoveRight} onClick={() => move(1)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border bg-background disabled:opacity-35"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      <div
        ref={viewportRef}
        data-mobile-table-scroll={label}
        role="region"
        aria-label={`${label} table`}
        tabIndex={0}
        onScroll={updatePosition}
        className="overflow-x-auto"
      >
        {children}
      </div>
    </div>
  )
}
