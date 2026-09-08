/**
 * dotrino-ad-integration — el directorio de la empresa RESPALDA una llave.
 *
 * Es el camino contrario a `dotrino-sso`: allí Dotrino es el proveedor de identidad y una
 * aplicación de fuera confía en él; aquí el proveedor es **Active Directory** (Entra ID,
 * ADFS, o cualquier directorio que hable OpenID Connect) y Dotrino confía en la empresa.
 *
 * LO ÚNICO QUE HACE ESTE SERVICIO ES UNIR DOS AFIRMACIONES:
 *
 *     paso 1  →  «quien está aquí controla la llave K»      (firma de la bóveda)
 *     paso 2  →  «quien está aquí es maria@empresa.com»     (token del directorio)
 *     ─────────────────────────────────────────────────────────────────────────────
 *     paso 3  →  firma: «la llave K es de maria@empresa.com, grupos [...]»
 *
 * LAS DOS SE ATAN CRIPTOGRÁFICAMENTE, NO POR LA SESIÓN. El `nonce` que se manda al
 * directorio es **la huella de K**, y K es la llave que firmó la prueba de la bóveda. Sin
 * eso cabe el ataque clásico: alguien empieza el recorrido con SU llave y consigue que la
 * víctima complete el acceso de Microsoft dentro de esa sesión — y el servicio acabaría
 * firmando que la llave del atacante es de la víctima. Un `state` impredecible es
 * necesario, pero no basta (DISENO §4.1).
 *
 * QUÉ PRUEBA Y QUÉ NO: «quien controla esta llave pudo entrar como María ahora mismo». No
 * prueba que sea María — si ella entrega su contraseña, quien la reciba obtiene una
 * atestación para SU llave. Es un problema del directorio de la empresa, no del ecosistema,
 * pero queda escrito porque es la clase de límite que después se da por resuelto.
 *
 * NO GUARDA NADA: ni cuentas, ni contraseñas, ni quién entró. Lo único persistente es su
 * par de llaves de firma. Y corre DENTRO de la empresa: Dotrino no participa en tiempo de
 * ejecución. Lo que se publica es el código.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { makeDeviceKey, pubkeyId } from '@dotrino/identity/capabilities'
import { verifyAssertion } from '@dotrino/identity/assertion'
import { signVerification } from '@dotrino/verifier'

const PORT = Number(process.env.PORT || 8099)
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const FLOW_TTL_MS = 10 * 60 * 1000

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(obj))
}
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''
  req.on('data', (c) => { b += c; if (b.length > 64 * 1024) { reject(new Error('body too large')); req.destroy() } })
  req.on('end', () => resolve(b))
  req.on('error', reject)
})
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/**
 * La huella de la llave que se está respaldando: es EL valor que ata las dos pruebas.
 * `pubkeyId` no sirve aquí — es corto a propósito, para que una persona lo lea en voz alta.
 */
export const keyFingerprint = (publickey) => b64url(crypto.createHash('sha256').update(String(publickey)).digest())

/** La llave de firma de la EMPRESA. Es lo único que este servicio custodia. */
async function loadOrCreateKey (file) {
  if (fs.existsSync(file)) {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!k?.privateJwk || !k?.publickey) throw new Error('signing key file is corrupt: ' + file)
    return k
  }
  const k = await makeDeviceKey({ label: 'directory bridge' })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ publickey: k.publickey, privateJwk: k.privateJwk, createdAt: k.createdAt }), { mode: 0o600 })
  return k
}

/**
 * Un servicio, con su configuración. Factoría y no módulo con estado: así se levanta más de
 * uno (las pruebas, o una empresa con dos directorios) sin que compartan nada.
 *
 * @param {object} cfg
 * @param {string} cfg.issuer      URL pública de ESTE servicio — es el `aud` de la prueba de la bóveda
 * @param {string[]} cfg.apps      las aplicaciones para las que puede firmar. Cerrada: lo que no está, no entra
 * @param {object} cfg.oidc        { discovery, clientId, clientSecret, redirectUri, scope }
 */
export async function createBridge ({ issuer, apps = [], oidc = {}, keyFile, attestationTtlMs = 12 * 60 * 60 * 1000, fetchImpl = fetch } = {}) {
  const ISSUER = String(issuer || '').trim().replace(/\/+$/, '')
  if (!ISSUER) throw new Error('createBridge: issuer required')
  if (!oidc.discovery || !oidc.clientId) throw new Error('createBridge: oidc.discovery and oidc.clientId required')
  // Lista CERRADA de aplicaciones. Sin ella el servicio firmaría para cualquier `aud` que le
  // pidan y reenviaría el navegador a donde le digan, que es un redirector abierto.
  const APPS = apps.map((a) => String(a).trim().replace(/\/+$/, '')).filter(Boolean)
  if (!APPS.length) throw new Error('createBridge: at least one app audience is required')
  const REDIRECT = String(oidc.redirectUri || (ISSUER + '/callback'))

  const key = await loadOrCreateKey(keyFile || path.join(process.env.HOME || '/tmp', '.dotrino-ad', 'signing-key.json'))

  /** Retos y recorridos en vuelo. En memoria y de minutos: no hay nada que filtrar. */
  const retos = new Map()   // nonce → exp
  const enCurso = new Map() // state → { fingerprint, sub, aud, returnTo, exp }
  const sweep = () => {
    const t = Date.now()
    for (const [k, exp] of retos) if (exp <= t) retos.delete(k)
    for (const [k, v] of enCurso) if (v.exp <= t) enCurso.delete(k)
  }

  let conf = null
  const descubrir = async () => (conf ||= await (await fetchImpl(oidc.discovery)).json())

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, ISSUER)
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS'
        })
        return res.end()
      }
      if (url.pathname === '/health') return json(res, 200, { ok: true, issuer: ISSUER })

      /** La pública de la empresa. Con esto una aplicación comprueba las atestaciones. */
      if (url.pathname === '/key') {
        return json(res, 200, { issuer: ISSUER, publickey: key.publickey, keyId: await pubkeyId(key.publickey), apps: APPS })
      }

      /**
       * EL RETO LO EMITE QUIEN VERIFICA. Si lo eligiera la aplicación, este servicio no
       * estaría comprobando frescura ninguna: aceptaría una prueba vieja que alguien
       * capturó, y el reto sería un adorno.
       */
      if (url.pathname === '/challenge') {
        sweep()
        const nonce = b64url(crypto.randomBytes(24))
        retos.set(nonce, Date.now() + CHALLENGE_TTL_MS)
        return json(res, 200, { nonce, audience: ISSUER, expiresIn: CHALLENGE_TTL_MS / 1000 })
      }

      // ---- PASO 1: llega la prueba de la bóveda y arranca el recorrido ----
      if (url.pathname === '/start' && req.method === 'POST') {
        sweep()
        const b = JSON.parse((await readBody(req)) || '{}')

        const aud = String(b.aud || '').trim().replace(/\/+$/, '')
        if (!APPS.includes(aud)) return json(res, 400, { error: 'unknown_app', message: 'esa aplicación no está en la lista del servicio' })
        const returnTo = String(b.return_to || '').trim()
        if (!returnTo) return json(res, 400, { error: 'no_return_to' })
        // A dónde se devuelve el navegador: al MISMO sitio para el que se firma. Si no,
        // esto es un redirector abierto con una firma de la empresa dentro.
        let ok = false
        try { ok = new URL(returnTo).origin === new URL(aud).origin } catch { ok = false }
        if (!ok) return json(res, 400, { error: 'return_to_mismatch', message: 'el retorno tiene que ser de la misma aplicación' })

        const nonce = String(b.nonce || '')
        if (!retos.delete(nonce)) return json(res, 400, { error: 'unknown_challenge', message: 'ese reto no es de aquí o ya venció' })

        const v = await verifyAssertion(b.assertion, { audience: ISSUER, nonce })
        if (!v.ok) return json(res, 401, { error: 'bad_assertion', reason: v.reason })

        const state = b64url(crypto.randomBytes(24))
        // EL RETO QUE VA AL DIRECTORIO ES LA HUELLA DE LA LLAVE (DISENO §4.1).
        const fingerprint = keyFingerprint(v.profileId)
        enCurso.set(state, { fingerprint, sub: v.profileId, aud, returnTo, exp: Date.now() + FLOW_TTL_MS })

        const c = await descubrir()
        const q = new URLSearchParams({
          response_type: 'code',
          client_id: oidc.clientId,
          redirect_uri: REDIRECT,
          scope: oidc.scope || 'openid profile email',
          state,
          nonce: fingerprint
        })
        return json(res, 200, { authorize: c.authorization_endpoint + '?' + q.toString(), state })
      }

      // ---- PASOS 2 y 3: vuelve del directorio, se comprueba la atadura y se FIRMA ----
      if (url.pathname === '/callback' && req.method === 'GET') {
        sweep()
        const state = url.searchParams.get('state') || ''
        const rec = enCurso.get(state)
        if (rec) enCurso.delete(state)   // un recorrido se completa UNA vez
        if (!rec) return json(res, 400, { error: 'unknown_flow', message: 'ese recorrido no existe o ya venció' })

        const code = url.searchParams.get('code') || ''
        if (!code) return json(res, 400, { error: 'no_code', detail: url.searchParams.get('error') || null })

        const c = await descubrir()
        const tr = await fetchImpl(c.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: oidc.clientId,
            ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {})
          })
        })
        const tok = await tr.json()
        if (!tok.id_token) return json(res, 401, { error: 'no_id_token', detail: tok.error_description || tok.error || null })

        const claims = JSON.parse(unb64url(tok.id_token.split('.')[1]).toString('utf8'))
        // LA ATADURA. Si el reto que vuelve no es la huella de la llave con la que se
        // empezó, este token es de OTRO recorrido: se para y se dice.
        if (claims.nonce !== rec.fingerprint) {
          return json(res, 401, { error: 'not_bound', message: 'el token del directorio no está atado a esta llave' })
        }
        const upn = claims.upn || claims.preferred_username || claims.email
        if (!upn) return json(res, 401, { error: 'no_upn', message: 'el directorio no dice quién es' })

        const att = await signVerification({
          verifierKey: key.privateJwk,
          verifierPubkey: key.publickey,
          sub: rec.sub,
          service: 'directory',
          claim: 'member',
          aud: rec.aud,
          ttlMs: attestationTtlMs,
          claims: {
            upn: String(upn).toLowerCase(),
            ...(claims.name ? { displayName: String(claims.name) } : {}),
            groups: Array.isArray(claims.groups) ? claims.groups.map(String) : []
          }
        })

        // Y SE OLVIDA. La atestación vuelve a la aplicación por el `#fragment`, que no
        // llega a ningún servidor — ni al de la aplicación. Del token del directorio y del
        // recorrido no queda nada aquí.
        const dest = rec.returnTo + (rec.returnTo.includes('#') ? '' : '#') + 'att=' + b64url(Buffer.from(JSON.stringify(att), 'utf8'))
        res.writeHead(302, { location: dest, 'cache-control': 'no-store' })
        return res.end()
      }

      return json(res, 404, { error: 'not_found' })
    } catch (e) {
      return json(res, 500, { error: 'server_error', detail: e?.message || String(e) })
    }
  })

  const timer = setInterval(sweep, 60_000)
  timer.unref()
  return {
    server,
    issuer: ISSUER,
    apps: APPS,
    publickey: key.publickey,
    listen: (p, host) => new Promise((r) => server.listen(p, host, () => r(server.address().port))),
    close: () => { clearInterval(timer); return new Promise((r) => server.close(r)) }
  }
}

async function main () {
  const issuer = process.env.AD_ISSUER
  const discovery = process.env.AD_OIDC_DISCOVERY
  const apps = String(process.env.AD_APPS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!issuer || !discovery || !process.env.AD_CLIENT_ID || !apps.length) {
    console.error('[ad] AD_ISSUER, AD_OIDC_DISCOVERY, AD_CLIENT_ID and AD_APPS are required')
    process.exit(1)
  }
  const b = await createBridge({
    issuer,
    apps,
    oidc: {
      discovery,
      clientId: process.env.AD_CLIENT_ID,
      clientSecret: process.env.AD_CLIENT_SECRET,
      redirectUri: process.env.AD_REDIRECT_URI,
      scope: process.env.AD_SCOPE
    },
    keyFile: process.env.AD_KEY_FILE,
    attestationTtlMs: process.env.AD_TTL_HOURS ? Number(process.env.AD_TTL_HOURS) * 3600_000 : undefined
  })
  await b.listen(PORT, process.env.AD_HOST)
  console.log(`[ad] directory bridge ${b.issuer} listening on :${PORT} for ${b.apps.join(', ')}`)
}

if (process.argv[1] && import.meta.url === 'file://' + process.argv[1]) main()
