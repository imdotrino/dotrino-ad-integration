/**
 * El puente, de punta a punta y sin salir a la red: una cuenta de verdad firma su prueba,
 * un directorio de mentira devuelve su token, y sale una atestación firmada por la empresa.
 *
 * Lo que se fija además del camino feliz es lo que NO puede pasar, que es para lo que
 * existe este servicio: que un token conseguido en OTRO recorrido —con otra llave— sirva
 * para respaldar la tuya (DISENO §4.1). Es el ataque que un `state` impredecible no para.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { Identity } from '@dotrino/identity/node'
import { verifyVerification } from '@dotrino/verifier'
import { createBridge, keyFingerprint } from '../server/server.js'

const ISSUER = 'https://ad.empresa.com'
const APP = 'https://chat.empresa.com'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Un directorio de mentira que habla OpenID Connect. Guarda lo que se le pidió al
 * autorizar y devuelve un `id_token` con ESE `nonce` — igual que Entra ID.
 */
async function directorio ({ upn = 'maria@empresa.com', name = 'María Ruiz', groups = ['Ingenieria', 'Todos'] } = {}) {
  const codigos = new Map()
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ issuer: base, authorization_endpoint: base + '/auth', token_endpoint: base + '/token' }))
    }
    if (url.pathname === '/auth') {
      // La persona se identifica (aquí, sin escribir nada) y vuelve con su código.
      const code = crypto.randomUUID()
      codigos.set(code, { nonce: url.searchParams.get('nonce') })
      res.writeHead(302, { location: url.searchParams.get('redirect_uri') + '?code=' + code + '&state=' + url.searchParams.get('state') })
      return res.end()
    }
    if (url.pathname === '/token') {
      let b = ''
      req.on('data', (c) => { b += c })
      return req.on('end', () => {
        const code = new URLSearchParams(b).get('code')
        const rec = codigos.get(code)
        codigos.delete(code)
        res.writeHead(200, { 'content-type': 'application/json' })
        if (!rec) return res.end(JSON.stringify({ error: 'invalid_grant' }))
        const claims = { iss: base, sub: 'u-maria', nonce: rec.nonce, upn, name, groups }
        res.end(JSON.stringify({ id_token: ['e30', b64url(JSON.stringify(claims)), 'x'].join('.') }))
      })
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => srv.listen(0, r))
  const base = 'http://127.0.0.1:' + srv.address().port
  return { base, discovery: base + '/.well-known/openid-configuration', close: () => srv.close(), codigos }
}

/** El servicio de la empresa, escuchando en un puerto libre. */
async function puente (dir, opts = {}) {
  const b = await createBridge({
    issuer: ISSUER,
    apps: [APP],
    oidc: { discovery: dir.discovery, clientId: 'dotrino-ad', clientSecret: 's3cr3t', redirectUri: 'http://127.0.0.1:0/callback' },
    keyFile: path.join(tmp(), 'k.json'),
    ...opts
  })
  const port = await b.listen(0)
  // El directorio devuelve el navegador a ESTE puerto, que no se sabe hasta escuchar.
  return { b, base: 'http://127.0.0.1:' + port, close: () => b.close() }
}

/** Una cuenta de verdad, con su acta, pidiendo su prueba como haría la aplicación. */
async function cuenta () {
  const dir = tmp()
  const id = await Identity.connect({ dir })
  return {
    id,
    profileId: (await id.profileActa())?.acta?.profileId || id.me.publickey,
    prueba: (nonce, audience = ISSUER) => id.requestAssertion({ audience, nonce, scopes: ['id:whoami'] }),
    borra: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** El recorrido entero, como lo hace un navegador: reto → prueba → directorio → atestación. */
async function recorrido (p, dir, quien, { aud = APP, returnTo = APP + '/entrar' } = {}) {
  const { nonce } = await (await fetch(p.base + '/challenge')).json()
  const assertion = await quien.prueba(nonce)
  const r = await fetch(p.base + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion, nonce, aud, return_to: returnTo })
  })
  if (!r.ok) return { fallo: await r.json(), status: r.status }
  const { authorize } = await r.json()
  // El directorio manda al navegador al `redirect_uri`, que aquí hay que reescribir al
  // puerto real del puente (en producción es una URL fija y no hace falta).
  const vuelta = await fetch(authorize.replace(encodeURIComponent('http://127.0.0.1:0/callback'), encodeURIComponent(p.base + '/callback')), { redirect: 'manual' })
  const cb = await fetch(vuelta.headers.get('location'), { redirect: 'manual' })
  return { status: cb.status, location: cb.headers.get('location'), body: cb.status === 302 ? null : await cb.json() }
}

const atestacionDe = (location) => JSON.parse(Buffer.from(new URL(location).hash.replace('#att=', ''), 'base64url').toString('utf8'))

test('el directorio respalda la llave: sale una atestación firmada, con grupos y destinatario', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const maria = await cuenta()

  const r = await recorrido(p, dir, maria)
  assert.equal(r.status, 302, JSON.stringify(r.body))

  const att = atestacionDe(r.location)
  assert.equal(att.op, 'verify')
  assert.equal(att.ch, 'directory')
  assert.equal(att.claim, 'member')
  assert.equal(att.sub, maria.profileId, 'respalda la llave que firmó la prueba')
  assert.equal(att.iss, p.b.publickey, 'la firma es de la empresa')
  assert.equal(att.aud, APP)
  assert.equal(att.claims.upn, 'maria@empresa.com')
  assert.deepEqual(att.claims.groups, ['Ingenieria', 'Todos'])

  // Y vale de verdad: la firma comprueba contra la pública que publica el servicio.
  assert.equal((await verifyVerification(att, { audience: APP })).ok, true)
  assert.equal((await verifyVerification(att, { audience: 'https://otra.empresa.com' })).ok, false)

  maria.borra(); await p.close(); dir.close()
})

test('EL ATAQUE: un token del directorio conseguido con otra llave no respalda la mía', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const atacante = await cuenta()
  const victima = await cuenta()

  // El atacante empieza SU recorrido y se queda con la URL del directorio…
  const { nonce } = await (await fetch(p.base + '/challenge')).json()
  const r = await fetch(p.base + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: await atacante.prueba(nonce), nonce, aud: APP, return_to: APP + '/entrar' })
  })
  const { authorize, state } = await r.json()

  // …y consigue que la VÍCTIMA complete el acceso de Microsoft. Como el reto que viaja al
  // directorio es la huella de la llave del atacante, el token vuelve atado a ESA llave.
  const u = new URL(authorize)
  assert.equal(u.searchParams.get('nonce'), keyFingerprint(atacante.profileId))
  assert.notEqual(u.searchParams.get('nonce'), keyFingerprint(victima.profileId))

  // Lo que el atacante NO puede hacer es meter en SU recorrido un token del mismo
  // directorio conseguido aparte: el puente compara el reto que vuelve con la huella con la
  // que empezó, y el de un acceso ajeno no es esa.
  const suelto = await fetch(dir.base + '/auth?' + new URLSearchParams({ redirect_uri: p.base + '/callback', state, nonce: 'de-otro-recorrido' }), { redirect: 'manual' })
  const cb = await fetch(suelto.headers.get('location'), { redirect: 'manual' })
  assert.equal(cb.status, 401)
  assert.equal((await cb.json()).error, 'not_bound')

  atacante.borra(); victima.borra(); await p.close(); dir.close()
})

test('el reto lo emite el servicio: uno inventado o repetido no entra', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const maria = await cuenta()

  const inventado = await fetch(p.base + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: await maria.prueba('me-lo-invento'), nonce: 'me-lo-invento', aud: APP, return_to: APP + '/' })
  })
  assert.equal(inventado.status, 400)
  assert.equal((await inventado.json()).error, 'unknown_challenge')

  // Y el que sí emitió el servicio vale UNA vez.
  const { nonce } = await (await fetch(p.base + '/challenge')).json()
  const assertion = await maria.prueba(nonce)
  const cuerpo = JSON.stringify({ assertion, nonce, aud: APP, return_to: APP + '/' })
  const cab = { method: 'POST', headers: { 'content-type': 'application/json' }, body: cuerpo }
  assert.equal((await fetch(p.base + '/start', cab)).status, 200)
  assert.equal((await fetch(p.base + '/start', cab)).status, 400, 'el mismo reto no se reutiliza')

  maria.borra(); await p.close(); dir.close()
})

test('una prueba dirigida a otro servicio no vale aquí', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const maria = await cuenta()

  const { nonce } = await (await fetch(p.base + '/challenge')).json()
  const r = await fetch(p.base + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: await maria.prueba(nonce, 'https://ad.otraempresa.com'), nonce, aud: APP, return_to: APP + '/' })
  })
  assert.equal(r.status, 401)
  assert.equal((await r.json()).reason, 'otro-destinatario')

  maria.borra(); await p.close(); dir.close()
})

test('la lista de aplicaciones es cerrada, y el retorno tiene que ser de la misma', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const maria = await cuenta()

  const pide = async (aud, returnTo) => {
    const { nonce } = await (await fetch(p.base + '/challenge')).json()
    const r = await fetch(p.base + '/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: await maria.prueba(nonce), nonce, aud, return_to: returnTo })
    })
    return { status: r.status, ...(await r.json()) }
  }

  assert.equal((await pide('https://no-registrada.com', 'https://no-registrada.com/')).error, 'unknown_app')
  // Un retorno a otro sitio con una firma de la empresa dentro es un redirector abierto.
  assert.equal((await pide(APP, 'https://malo.example/roba')).error, 'return_to_mismatch')

  maria.borra(); await p.close(); dir.close()
})

test('un recorrido se completa una sola vez', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const maria = await cuenta()

  const { nonce } = await (await fetch(p.base + '/challenge')).json()
  const { authorize } = await (await fetch(p.base + '/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: await maria.prueba(nonce), nonce, aud: APP, return_to: APP + '/' })
  })).json()

  const u = authorize.replace(encodeURIComponent('http://127.0.0.1:0/callback'), encodeURIComponent(p.base + '/callback'))
  const vuelta = await fetch(u, { redirect: 'manual' })
  const donde = vuelta.headers.get('location')
  assert.equal((await fetch(donde, { redirect: 'manual' })).status, 302)
  const otra = await fetch(donde, { redirect: 'manual' })
  assert.equal(otra.status, 400)
  assert.equal((await otra.json()).error, 'unknown_flow')

  maria.borra(); await p.close(); dir.close()
})

test('el servicio publica su llave, y es con la que firma', async () => {
  const dir = await directorio()
  const p = await puente(dir)
  const k = await (await fetch(p.base + '/key')).json()
  assert.equal(k.issuer, ISSUER)
  assert.equal(k.publickey, p.b.publickey)
  assert.deepEqual(k.apps, [APP])
  await p.close(); dir.close()
})
