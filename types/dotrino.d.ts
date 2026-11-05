// Los pilares que usa este servicio no publican tipos para estas rutas: aquí va lo que se
// usa de ellos, y nada más.

declare module '@dotrino/identity/capabilities' {
  /** A device signing key (ECDSA P-256). `publickey` is the public JWK as a string. */
  export function makeDeviceKey (opts?: { label?: string }): Promise<{
    publickey: string
    privateJwk: import('node:crypto').JsonWebKey
    publicJwk: import('node:crypto').JsonWebKey
    label: string
    createdAt: number
    deviceId: string
  }>
  /** The short, human-readable id of a public key (`AB12-CD34-…`). */
  export function pubkeyId (publickey: string): Promise<string>
}

declare module '@dotrino/identity/assertion' {
  export type AssertionResult =
    | { ok: true, profileId: string, signer: string, seq: number, scopes: string[], claims: Record<string, unknown>, aud: string, exp: number }
    | { ok: false, reason: string }
  /** Is this vault proof valid for `audience` and `nonce`, now? */
  export function verifyAssertion (assertion: unknown, opts?: {
    audience?: string
    nonce?: string
    expectedProfileId?: string | null
    now?: number
    maxSkewMs?: number
  }): Promise<AssertionResult>
}

declare module '@dotrino/verifier' {
  /** The verifier signs an `op:'verify'` attestation about `sub`. */
  export function signVerification (opts: {
    verifierKey: import('node:crypto').JsonWebKey
    verifierPubkey: string
    sub: string
    service: string
    handle?: string
    reveal?: boolean
    ttlMs?: number | null
    proofUrl?: string | null
    aud?: string | null
    claim?: string
    claims?: Record<string, unknown> | null
  }): Promise<Record<string, unknown>>
}

declare module '@dotrino/update/deps' {
  /** Watches every pillar the service at `dir` depends on. Returns how to stop. */
  export function watchDependencies (opts?: {
    dir?: string
    match?: RegExp
    name?: string
    log?: (line: string) => void
  }): () => void
}
