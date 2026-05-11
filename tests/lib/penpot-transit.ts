// Penpot RPC responses (e.g. `/api/rpc/command/get-profile`) come back
// as Transit-JSON: a flat array starting with the `"^ "` marker followed
// by alternating keys (`~:email`, `~:fullname`, etc.) and values. Used
// by both `identity-consistency.spec.ts` and `header-spoofing.spec.ts`;
// kept in one place so any shape drift (e.g. Penpot wrapping the
// response in `{"~:result": [...]}`) is fixed once.

export function extractPenpotTransitField(
  body: unknown,
  key: `~:${string}`
): string {
  if (!Array.isArray(body)) {
    throw new Error(
      `Penpot RPC response is not a Transit array; got ${typeof body}`
    );
  }
  if (body[0] !== "^ ") {
    throw new Error(
      `Penpot RPC response missing Transit map marker "^ "; got first elem ${JSON.stringify(body[0])}`
    );
  }
  const idx = body.indexOf(key);
  if (idx < 0 || idx + 1 >= body.length) {
    throw new Error(
      `Penpot RPC response missing key ${key}: ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  return String(body[idx + 1]);
}
