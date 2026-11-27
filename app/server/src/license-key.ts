/**
 * Vendor public key (Ed25519) used to check licence keys. Only the matching private key — kept by the vendor,
 * outside this repository (~/.tracker-licensing/vendor-private.pem) — can create keys this build accepts.
 * To rotate: `npm run license -- keygen --out <new dir>`, paste the new public key here, re-issue every customer's key.
 */
export const VENDOR_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbZoChkXa9dL8VHInq+Dy+bDpqbhmkynzYdyLzI7Ml/U=
-----END PUBLIC KEY-----
`;
