/** Hand-written interop helper consumed from GRHM via (use "./lib/pricing.ts" ...). */
export function discounted(price: number): number {
  return Math.round(price * 0.85 * 100) / 100;
}
