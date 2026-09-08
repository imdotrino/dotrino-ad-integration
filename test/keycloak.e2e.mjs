/**
 * El recorrido ENTERO contra un directorio de verdad — un Keycloak con su realm, su usuaria
 * y sus grupos — incluido el formulario de la contraseña, que aquí se rellena con HTTP a
 * pelo en lugar de un navegador.
 *
 * No entra en `npm test` a propósito: necesita Docker y un contenedor levantado. Se corre a
 * mano cuando se toca el flujo, y es lo que separa «los tests pasan» de «esto funciona».
 *
 *   docker run -d --name kc-prueba -p 8095:8080 \
 *     -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
 *     quay.io/keycloak/keycloak:26.0 start-dev
 *   node test/keycloak.e2e.mjs      (con el realm `empresa` ya preparado)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Identity } from '@dotrino/identity/node'
import { verifyVerification } from '@dotrino/verifier'
import { createBridge, keyFingerprint } from '../server/server.js'

const KC = process.env.KC_BASE || 'http://localhost:8095'
const REALM = process.env.KC_REALM || 'empresa'
const PORT = 8099                                   // el retorno que tiene registrado Keycloak
const ISSUER = 'http://localhost:' + PORT
const APP = 'https://chat.empresa.com'
const USER = process.env.KC_USER || 'maria'
const PASS = process.env.KC_PASS || 'prueba1234'

/** Un navegador de mentira: guarda las galletas y sigue los saltos a mano. */
function navegador () {
  const galletas = new Map()
  const guarda = (r) => {
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      galletas.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
  }
  const cabecera = () => [...galletas].map(([k, v]) => `${k}=${v}`).join('; ')
  return {
    async ir (url, init = {}) {
      const r = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), cookie: cabecera() } })
      guarda(r)
      return r
    },
    /** Sigue saltos hasta salir del dominio del directorio. */
    async seguir (r, hasta) {
      let cur = r
      for (let i = 0; i < 10 && cur.status >= 300 && cur.status < 400; i++) {
        const loc = new URL(cur.headers.get('location'), KC).toString()
        if (hasta && loc.startsWith(hasta)) return { fuera: loc, r: cur }
        cur = await this.ir(loc)
      }
      return { fuera: null, r: cur }
    }
  }
}

const paso = (t) => console.log('  · ' + t)

async function main () {
  console.log(`Keycloak en ${KC}, realm «${REALM}»`)
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-e2e-'))

  const b = await createBridge({
    issuer: ISSUER,
    apps: [APP],
    oidc: {
      discovery: `${KC}/realms/${REALM}/.well-known/openid-configuration`,
      clientId: process.env.KC_CLIENT_ID || 'dotrino-ad',
      clientSecret: process.env.KC_CLIENT_SECRET || 'secreto-de-prueba',
      redirectUri: ISSUER + '/callback',
      scope: 'openid profile email'
    },
    keyFile: path.join(dirTmp, 'k.json')
  })
  await b.listen(PORT)
  paso(`el servicio de la empresa escucha en ${ISSUER}`)

  // ---- 1. la bóveda: una cuenta de verdad, con su acta ----
  const id = await Identity.connect({ dir: dirTmp })
  const profileId = (await id.profileActa())?.acta?.profileId || id.me.publickey
  paso('la bóveda tiene su perfil de trabajo')

  // ---- 2. el reto lo emite quien verifica, y la bóveda firma la prueba ----
  const { nonce } = await (await fetch(ISSUER + '/challenge')).json()
  const assertion = await id.requestAssertion({ audience: ISSUER, nonce, scopes: ['id:whoami'] })
  const r = await fetch(ISSUER + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion, nonce, aud: APP, return_to: APP + '/entrar' })
  })
  const arranque = await r.text()
  assert.equal(r.status, 200, arranque)
  const { authorize } = JSON.parse(arranque)
  assert.equal(new URL(authorize).searchParams.get('nonce'), keyFingerprint(profileId), 'el reto al directorio es la huella de la llave')
  paso('la prueba de la bóveda vale, y el reto al directorio va atado a la llave')

  // ---- 3. la pantalla de siempre: María escribe su contraseña en Keycloak ----
  const nav = navegador()
  const login = await nav.ir(authorize)
  const html = await login.text()
  const accion = /action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&')
  assert.ok(accion, 'no se encontró el formulario de acceso')
  const enviado = await nav.ir(accion, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USER, password: PASS, credentialId: '' })
  })
  paso(`«${USER}» se identificó en el directorio`)

  // ---- 4. vuelve al servicio, que ata las dos pruebas y firma ----
  const { fuera } = await nav.seguir(enviado, ISSUER)
  assert.ok(fuera, 'el directorio no devolvió al servicio')
  const cb = await fetch(fuera, { redirect: 'manual' })
  assert.equal(cb.status, 302, cb.status === 302 ? '' : await cb.text())

  const destino = cb.headers.get('location')
  assert.ok(destino.startsWith(APP), 'el retorno es la aplicación, y nadie más')
  const att = JSON.parse(Buffer.from(new URL(destino).hash.replace('#att=', ''), 'base64url').toString('utf8'))
  paso('el servicio firmó la atestación y devolvió a la aplicación por el #fragment')

  // ---- 5. lo que la aplicación comprueba ----
  assert.equal(att.ch, 'directory')
  assert.equal(att.claim, 'member')
  assert.equal(att.sub, profileId)
  assert.equal(att.aud, APP)
  assert.equal((await verifyVerification(att, { audience: APP })).ok, true, 'la firma de la empresa no valida')
  assert.equal((await verifyVerification(att, { audience: 'https://otra.empresa.com' })).ok, false)

  console.log('\n  atestación:', JSON.stringify({ upn: att.claims.upn, displayName: att.claims.displayName, groups: att.claims.groups }, null, 0))
  console.log('  vigencia :', new Date(att.ts).toISOString(), '→', new Date(att.exp).toISOString())
  console.log('  firmada  por la empresa, para', att.aud)
  console.log('\nOK — el directorio respalda la llave de punta a punta.')

  await b.close()
  fs.rmSync(dirTmp, { recursive: true, force: true })
  process.exit(0)
}

main().catch((e) => { console.error('FALLÓ:', e?.message || e); process.exit(1) })
