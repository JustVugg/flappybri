import type { ReactElement } from "react"

import { LOGO_COLORS, LOGO_ROWS } from "../lib/flappybri/render"

/* colibri's hummingbird, the mark of the page: the same 11 x 9 cells and five
 * colors as public/colibri-icon.svg, drawn from the very rows the game flies,
 * so the logo in the header and the bird between the pipes cannot drift
 * apart. Here the beak points left, as in the logo. */
export function Brand({ className }: { className?: string }) {
  const cell = 14
  const rects: ReactElement[] = []
  LOGO_ROWS.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      const key = line[col]
      if (key === ".") continue
      rects.push(<rect key={`${row}-${col}`} x={col * cell} y={row * cell} width={cell} height={cell} fill={LOGO_COLORS[key]} />)
    }
  })
  return (
    <svg className={className} viewBox={`0 0 ${LOGO_ROWS[0].length * cell} ${LOGO_ROWS.length * cell}`}
         shapeRendering="crispEdges" aria-hidden="true">
      {rects}
    </svg>
  )
}
