export type ExpectedRefundTerms =
  | { ok: true; provided: false }
  | { ok: true; provided: true; expectedRefundCents: number }
  | { ok: false };

export async function parseOptionalExpectedRefundCents(
  readText: () => Promise<string>,
): Promise<ExpectedRefundTerms> {
  const raw = await readText();
  if (!raw.trim()) return { ok: true, provided: false };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!body || typeof body !== "object" || !("expected_refund_cents" in body)) {
    return { ok: true, provided: false };
  }
  const value = (body as { expected_refund_cents?: unknown }).expected_refund_cents;
  if (!Number.isSafeInteger(value) || Number(value) < 0) return { ok: false };
  return { ok: true, provided: true, expectedRefundCents: Number(value) };
}

export function logBodylessBookingCancellation(input: {
  bookingId: string;
  actorRole: "host" | "booker";
}): void {
  console.info("[booking-cancellation] compatibility", JSON.stringify({
    booking_id: input.bookingId,
    actor_role: input.actorRole,
    bodyless_cancel: true,
  }));
}
