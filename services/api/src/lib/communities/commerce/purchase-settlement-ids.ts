export function derivePurchaseIdForQuote(quoteId: string): string {
  return `pur_${quoteId.replace(/^quo_/, "")}`
}

export function derivePurchaseAllocationLegId(purchaseId: string, waterfallPosition: number): string {
  return `pal_${purchaseId.replace(/^pur_/, "")}_${waterfallPosition}`
}

export function derivePurchaseEntitlementId(purchaseId: string): string {
  return `ent_${purchaseId.replace(/^pur_/, "")}`
}
