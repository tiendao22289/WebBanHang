import { NextResponse } from 'next/server';

// Payments are confirmed by staff in the admin table screen. A QR reference
// is not proof of a bank transfer, so this legacy public endpoint must never
// mark orders or transactions paid merely because a caller knows that code.
export async function POST() {
  return NextResponse.json(
    { error: 'Automatic payment confirmation is disabled; staff must verify the transfer and close the bill in admin.' },
    { status: 410 },
  );
}
