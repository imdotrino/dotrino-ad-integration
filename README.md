# dotrino-ad-integration

**Que tu gente entre a las aplicaciones de Dotrino con la misma cuenta de la
empresa que ya usa todos los días — sin escribir esa contraseña en ningún sitio
nuevo.**

Este servicio conecta el **Active Directory** de una empresa con el ecosistema
[Dotrino](https://dotrino.com/). Corre **dentro de la empresa**, en su propia red.
Su único trabajo: comprobar contra Active Directory que quien pide entrar trabaja
ahí, y **respaldar con una firma** la llave de esa persona, para que las
aplicaciones sepan a quién están dejando pasar.

Parte de la línea [Dotrino Enterprise](https://dotrino.com/enterprise) · MIT.

> **Estado: el servicio funciona.** Hecho el 2026-09-07 y probado de punta a punta
> contra un directorio de verdad (un Keycloak con su realm, su gente y sus grupos),
> formulario de contraseña incluido: `node test/keycloak.e2e.mjs`. Lo que queda es lo
> que convierte esto en un producto — salas con política en el chat, la puerta en el
> proxio y la llave de sala condicionada—, que es trabajo de otros repos
> ([`docs/DISENO.md`](./docs/DISENO.md) §10, fases 3 a 5).
>
> **Es la tercera de tres direcciones, y va al final** (orden fijado por el dueño el
> 2026-09-05): primero entrar en un aparato nuevo dentro del ecosistema
> ([`dotrino-vault/docs/inicio-de-sesion.md`](../dotrino-vault/docs/inicio-de-sesion.md)),
> después "Entrar con Dotrino" en aplicaciones ajenas
> ([`dotrino-sso`](../dotrino-sso/)), y al final esto. Las tres comparten la misma
> primera pieza: el destinatario y la vigencia en el sobre firmado.

---

## 1. El problema

Una empresa quiere su chat interno cifrado, y quiere que entren sus empleados y
nadie más. Lo natural sería pedir la contraseña de la empresa… y ahí está la
trampa: **una aplicación que pide la contraseña corporativa es indistinguible de un
engaño**, y quien se acostumbra a escribirla en pantallas nuevas termina
escribiéndola donde no debe.

Así que aquí no se pide nunca. La contraseña se escribe **solo en la pantalla de
siempre** —la de Microsoft—, exactamente como para el correo.

## 2. Cómo funciona

```
1. María abre el chat de la empresa.
   Su equipo tiene una llave que nunca sale de él.

2. El chat la manda al servicio de la empresa.

3. El servicio la lleva a la pantalla de acceso de siempre (Microsoft),
   donde escribe su contraseña como cualquier otro día.

4. De vuelta, el servicio FIRMA un respaldo:
   «esta llave es de María, del área de Ingeniería, válido por hoy».

5. El chat comprueba esa firma y la deja entrar a las salas de Ingeniería.
```

Tres cosas que **no** ocurren en ese recorrido, y son el punto entero:

- La contraseña **no pasa** por Dotrino ni por este servicio.
- La llave de María **no sale** de su equipo, ni siquiera hacia su empresa.
- Dotrino **no se entera** de nada: el servicio es de la empresa y corre en su red.

## 3. Qué es y qué no es

| | |
|---|---|
| **Es** | Un servicio que la empresa instala en su red, junto a su Active Directory. |
| **Es** | Un **respaldo firmado**: dice quién es alguien y a qué área pertenece, y lo dice con una firma que cualquiera puede comprobar. |
| **No es** | Un sitio donde escribir la contraseña de la empresa. Nunca la ve. |
| **No es** | Un guardián de llaves. Las llaves viven en el equipo de cada persona. |
| **No es** | Un servicio de Dotrino. Es de la empresa; nosotros publicamos el código. |
| **No es** | [`dotrino-sso`](../dotrino-sso/), que va **al revés**: aquel deja que aplicaciones de fuera confíen en Dotrino; este deja que Dotrino confíe en la empresa. |

## 4. Qué resuelve el día a día

- **Alta**: quien entra a la empresa ya tiene acceso; no hay que crear otra cuenta.
- **Baja**: quien sale deja de tener acceso **solo**, sin que nadie se acuerde de
  ir aplicación por aplicación. El respaldo dura una jornada y deja de renovarse
  en cuanto Active Directory deja de reconocerle.
- **Áreas**: los grupos que ya existen en Active Directory deciden a qué salas
  entra cada quien. No hay una segunda lista de permisos que mantener.

Lo que **no** resuelve, y se dice de frente: lo que alguien ya leyó, ya lo leyó.
Darle de baja corta el acceso de ahí en adelante, no borra lo que se llevó puesto.

## 5. Piezas relacionadas

| Pieza | Papel |
|---|---|
| [`dotrino-vault`](../dotrino-vault/) | La llave de cada persona y su perfil de trabajo. |
| [`@dotrino/verifier`](../dotrino-verifier/) | El formato del respaldo firmado por un tercero. Este servicio es uno de esos terceros. |
| [`@dotrino/reputation`](../dotrino-reputation/) | Donde vive el respaldo y con qué peso cuenta. |
| [`dotrino-chat`](../dotrino-chat/) | Primer consumidor: salas con acceso por área. |
| [`dotrino-proxy`](../dotrino-proxy/) | Donde el acceso se hace de verdad efectivo. |
| [`dotrino-sso`](../dotrino-sso/) | El camino inverso (Dotrino como proveedor de identidad). |

## 6. Cómo se levanta

Node 22 o superior. Corre en la red de la empresa, junto a su directorio.

```bash
npm install
AD_ISSUER=https://ad.empresa.com \
AD_OIDC_DISCOVERY=https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration \
AD_CLIENT_ID=<id de la aplicación registrada> \
AD_CLIENT_SECRET=<su secreto> \
AD_APPS=https://chat.empresa.com \
npm start
```

| Variable | Qué es |
|---|---|
| `AD_ISSUER` | La dirección pública **de este servicio**. Es a quien va dirigida la prueba que firma la bóveda: si no coincide, no vale. |
| `AD_OIDC_DISCOVERY` | El documento de descubrimiento del directorio (Entra ID, ADFS, Keycloak…). |
| `AD_CLIENT_ID` / `AD_CLIENT_SECRET` | La aplicación que la empresa registra en su directorio. |
| `AD_APPS` | Las aplicaciones para las que puede firmar, separadas por comas. **Lista cerrada**: lo que no está, no entra. |
| `AD_REDIRECT_URI` | Por omisión `<AD_ISSUER>/callback`. Tiene que estar registrado en el directorio. |
| `AD_TTL_HOURS` | Cuánto dura el respaldo. Por omisión 12 h — una jornada. |
| `AD_KEY_FILE` | Dónde vive la llave de firma de la empresa. Por omisión `~/.dotrino-ad/signing-key.json`, en 0600. Es lo **único** que este servicio guarda: si se pierde, los respaldos ya emitidos dejan de comprobar. |

Cuatro direcciones, y ninguna más: `GET /challenge` (el reto), `POST /start` (la prueba
de la bóveda), `GET /callback` (la vuelta del directorio) y `GET /key` (la pública con la
que se comprueban los respaldos).

### Probarlo sin tener un Active Directory

```bash
./test/keycloak-setup.sh     # levanta un directorio de prueba en Docker
node test/keycloak.e2e.mjs   # el recorrido entero contra él
docker rm -f kc-prueba
```

`npm test` no necesita nada de eso: usa un directorio de mentira y cubre, además del
camino feliz, el ataque que este diseño existe para parar (§4.1 del diseño).

### Contra Entra ID de verdad

Dos cosas cambian, y las dos son configuración del directorio, no de aquí:

- **`upn`** hay que pedirlo como *claim* opcional en la aplicación registrada. Sin él, el
  servicio se queda con `preferred_username` o el correo.
- **`groups`** llega por omisión como identificadores internos. Para que sean nombres hay
  que configurarlo en la aplicación (`groupMembershipClaims` con los nombres del local
  de AD). Lo que el directorio diga es lo que se firma: aquí no se traduce nada.

## 7. Documentación

- [`docs/DISENO.md`](./docs/DISENO.md) — arquitectura, formato del respaldo
  firmado, salas con política, bajas, Entra ID frente a LDAP, qué hay que cambiar
  en el chat y en el proxio, fases y decisiones pendientes.
