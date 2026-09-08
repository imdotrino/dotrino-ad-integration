# Diseño — `dotrino-ad-integration` (Active Directory como respaldo de identidad)

> **Estado:** el servicio (§10 fase 2) **está escrito y probado de punta a punta** contra
> un directorio de verdad, el 2026-09-07. Lo que sigue abierto son las fases 3 a 5, que
> viven en `dotrino-chat` y `dotrino-proxy`. Las decisiones que la implementación tuvo
> que cerrar están en §11 con lo que se decidió y por qué; las que siguen abiertas, sin
> respuesta.
>
> **Idioma/estilo:** español neutro (tuteo). Fuente de verdad del ecosistema:
> [`CLAUDE.md`](../../CLAUDE.md) y
> [`CONVENCIONES-APPS.md`](../../CONVENCIONES-APPS.md). El **código va en inglés**
> (§8.1): los identificadores de este documento ya lo están.

## 1. Propósito

Que los empleados de una empresa entren a las aplicaciones del ecosistema con las
cuentas corporativas que ya existen (Active Directory), sin que ninguna
contraseña corporativa se escriba en una pantalla de Dotrino y sin que ninguna
llave privada salga del equipo de su dueño.

### Deslindes

- **No es [`dotrino-sso`](../../dotrino-sso/).** Ese va al revés: allí Dotrino **es**
  el proveedor de identidad y una aplicación ajena confía en él. Aquí **Active
  Directory** es el proveedor y Dotrino confía en él. Comparten maquinaria (sobres
  firmados con destinatario, alcances, vigencias cortas), no dirección.
- **No es un proveedor de identidad más.** No autentica: delega la autenticación en
  Microsoft y se limita a **firmar el resultado**.
- **No sustituye al vault.** La llave, el perfil y la firma del usuario siguen en
  su bóveda. Este servicio no custodia nada del usuario.
- **No es autorización.** Dice *quién es* y *a qué grupos pertenece*. Quién entra a
  qué sala lo decide la aplicación (§6).

## 2. El choque de modelos, y cómo se resuelve

Active Directory afirma: *"quien escribió esta contraseña es `juan@empresa.com`,
del grupo Ingeniería"*. Dotrino afirma: *"quien firmó esto tiene esta llave
privada"*. Son afirmaciones de distinta naturaleza, y la contraseña **no puede**
entrar en el ecosistema: una aplicación que pide credenciales corporativas es
indistinguible de un engaño, y entrena al empleado en el hábito exacto que hay que
evitar.

La unión no es "el chat valida contra Active Directory". Es:

> **Active Directory respalda una llave.**

La autenticación ocurre donde siempre (Microsoft), y el resultado se convierte en
un **sobre firmado** que las aplicaciones ya saben comprobar.

## 3. Arquitectura

```
  ┌──────────── red de la empresa ────────────┐        ┌─── equipo de María ───┐
  │                                            │        │                       │
  │   Active Directory  (Entra ID / ADFS)      │        │  bóveda (vault)       │
  │        ▲                                   │        │  · llave privada      │
  │        │ OIDC (la contraseña se escribe    │        │    (no sale nunca)    │
  │        │ SOLO en la pantalla de Microsoft) │        │  · perfil de trabajo  │
  │        │                                   │        └───────────┬───────────┘
  │  ┌─────┴──────────────────────────────┐    │                    │ firma
  │  │  dotrino-ad-integration            │◄───┼────────────────────┘
  │  │  · verifica la prueba de la bóveda │    │
  │  │  · consulta grupos en el directorio│    │
  │  │  · FIRMA la atestación             │────┼──────► atestación firmada
  │  │  · no guarda usuarios ni llaves    │    │        { sub, upn, groups, exp }
  │  └────────────────────────────────────┘    │                    │
  └────────────────────────────────────────────┘                    │
                                                                     ▼
                                            ┌──────────────────────────────────┐
                                            │  dotrino-chat  ·  dotrino-proxy  │
                                            │  comprueban la firma de la       │
                                            │  empresa y aplican la política   │
                                            └──────────────────────────────────┘
```

**Todo el servicio corre dentro de la empresa.** Dotrino no participa en tiempo de
ejecución ni ve quién entra a dónde. Lo que publicamos es el código.

## 4. El recorrido, paso a paso

1. María abre `chat.empresa.com`. Su bóveda tiene (o crea) la llave de su **perfil
   de trabajo**, distinto de su perfil personal (el ecosistema ya soporta varios
   perfiles por dispositivo).
2. El chat pide a la bóveda una **prueba firmada** con `audience` = el servicio de
   la empresa y un reto de un solo uso. María aprueba en su bóveda.
3. El chat la manda al servicio, que **verifica** esa prueba: destinatario, reto,
   vigencia, y la cadena hasta el certificado del dispositivo.
4. El servicio inicia un flujo **OpenID Connect** contra Entra ID o ADFS. María
   escribe su contraseña en la pantalla de Microsoft, como cualquier otro día.
5. De vuelta, el servicio lee `upn` y grupos, y **firma la atestación** (§5).
6. El chat la comprueba contra la llave pública de la empresa y aplica la política
   de la sala (§6).

Nótese qué se ata a qué: el paso 2 prueba **posesión de la llave**, el paso 4
prueba **pertenencia a la empresa**, y el paso 5 los une en un solo documento
firmado. Sin el paso 2, la empresa estaría respaldando una llave que quien pide
pudo haber puesto de cualquiera.

### 4.1. Cómo sabe el servicio de quién es la llave

No lo sabe de antemano, y **no hay ninguna tabla** que lo diga. Lo aprende porque
las dos pruebas llegan en el mismo recorrido:

```
  paso 2  →  «quien está aquí controla la llave K»       (firma de la bóveda)
  paso 4  →  «quien está aquí es maria@empresa.com»      (token de Microsoft)
  ───────────────────────────────────────────────────────────────────────────
  paso 5  →  firma: «la llave K es de maria@empresa.com»
```

Es el mismo razonamiento que cuando se sube una llave SSH a una cuenta: nadie sabía
que esa llave era de quien la sube; se supo porque **la subió con la sesión
iniciada**. Aquí ocurre en un solo recorrido y no queda guardado.

**La unión NO puede depender solo de la sesión.** Si lo único que ata las dos
pruebas es "el mismo navegador", cabe el ataque clásico de sesión: alguien inicia el
recorrido con **su** llave y consigue que la víctima complete el acceso de Microsoft
dentro de esa sesión; el servicio firmaría que la llave del atacante es de la
víctima. Que el `state` sea impredecible y esté atado a la cookie es necesario, pero
insuficiente como única defensa.

**Las dos pruebas se atan criptográficamente:**

- El `nonce` que el servicio envía a Microsoft **es el hash de la llave `K`**.
- La prueba que firma la bóveda va firmada **por esa misma `K`**, así que el servicio la
  deduce en vez de fiarse de que se la digan (`server/server.js`, `keyFingerprint`).

Así el token que vuelve del directorio queda atado a `K`: un token obtenido en otro
recorrido, con otra llave, no encaja. La unión deja de depender de la sesión.

**Y el reto de la prueba lo emite el servicio, no la aplicación** (`GET /challenge`).
Aceptar un reto elegido por quien llama es no comprobar frescura ninguna: una prueba
capturada valdría igual y el reto sería un adorno. Se emite, se gasta una vez y vence a
los cinco minutos.

**Lo que esto prueba, y lo que no.** La afirmación honesta es *"quien controla esta
llave pudo iniciar sesión como María ahora mismo"*. No prueba que sea María: si
María entrega su contraseña, quien la reciba obtiene una atestación **para su propia
llave**. Es un problema del directorio de la empresa, no del ecosistema — pero queda
escrito, porque es la clase de límite que después se asume resuelto.

**Efecto secundario a decidir (§11).** Como el servicio no guarda nada, *cualquier*
llave que supere un acceso al directorio queda respaldada: no existe "los
dispositivos conocidos de María". Con tres equipos obtiene tres atestaciones, y
ninguna sabe de las otras. Es coherente con el modelo (el vault ya trata cada
dispositivo como una llave con su certificado) y hace al servicio trivial de
auditar; una empresa con requisitos estrictos querrá lo contrario —lista de
dispositivos, aprobación del administrador, límite— y eso obliga a guardar estado.

## 5. La atestación

**No se inventa un formato.** Es una atestación de
[`@dotrino/verifier`](../../dotrino-verifier/) (`op: 'verify'`), el mismo mecanismo
de verificador-tercero firmante que ya está escrito. Lo que cambia es **quién
firma**: aquí el tercero no es un bot de Dotrino comprobando un dominio, es el
Active Directory de la empresa.

```jsonc
{
  "op":     "verify",
  "sub":    "<pubkey del perfil de trabajo>",   // a quién respalda
  "iss":    "<pubkey del servicio de la empresa>",
  "aud":    "https://chat.empresa.com",          // PARA QUIÉN vale
  "claims": {
    "upn":         "maria@empresa.com",
    "displayName": "María …",
    "groups":      ["Ingenieria", "Todos"]
  },
  "iat":    1767000000,
  "exp":    1767028800     // una jornada
}
```

- **`aud` obligatorio.** Depende de la fase 1 de
  [`dotrino-sso`](../../dotrino-sso/docs/FASES.md): sin destinatario, una atestación
  emitida para el chat serviría ante cualquier otro servicio.
- **`exp` de una jornada**, con renovación silenciosa (§7).
- **`groups`**: los de Active Directory, tal cual. **No** se inventa una segunda
  lista de permisos que alguien tendría que mantener en paralelo.
- **Alcance mínimo**: se firma lo que la aplicación necesita. Una sala que solo
  filtra por área no necesita el nombre completo de nadie.

### Peso de la firma

En el registro de reputación, la llave de la empresa **pesa el 100 % para sus
propias salas y nada fuera de ellas**. No hay que inventar un sistema de
autorización: la maquinaria de confianza ya distingue *quién firma* y *cuánto vale
esa firma según para qué*.

## 6. Qué hay que cambiar en el chat

Hoy las salas de [`dotrino-chat`](../../dotrino-chat/) son **abiertas**: se entra por
nombre de canal del proxio, la membresía es quien esté ahí y no hay control de
acceso ninguno (`src/stores/roomStore.js`, `joinRoom`). Hacen falta cuatro cosas:

1. **Salas con política.** Una sala deja de ser un nombre y pasa a ser
   `{ name, policy: { issuer: <pubkey de la empresa>, group: "Ingenieria" } }`.
2. **Puerta al unirse.** Quien entra presenta su atestación; quienes ya están la
   comprueban.
3. **La puerta de verdad está en el proxio.** Si solo comprueba la aplicación, la
   puerta es decorativa: quien hable el protocolo a mano entra igual.
   [`dotrino-proxy`](../../dotrino-proxy/) debe rechazar el canal a quien no
   presente atestación válida.
4. **La llave de la sala.** El chat es cifrado extremo a extremo: *entrar* significa
   **recibir la llave de la sala**. Quien no presenta atestación válida no la
   recibe, y ahí el control deja de ser una casilla de interfaz y pasa a ser
   criptográfico.

El punto 4 es el que hace que esto sirva de algo. Los otros tres sin él son
cosmética.

### 6.1. Qué puede hacer cada quien (y qué de esto es de ahora)

La pregunta natural de una empresa no es *quién es*, sino **a qué accede, qué
guarda y qué modifica**. Casi todo eso se puede dejar para después; una parte no.

**Se puede posponer:** roles finos (leer / escribir / administrar), retención,
cuotas, borrado, registro de quién hizo qué. Se añade encima sin rehacer nada.

**No se puede posponer:** en un sistema cifrado extremo a extremo, **autorizar la
lectura es repartir la llave**. Eso no es un permiso que se agregue más tarde: se
decide el día que se entrega la primera llave de sala. Si se reparte a todo el que
entra al canal, luego no se le puede "quitar el permiso" a quien ya la tiene — solo
**rotar** la llave y no dársela, y esa rotación tiene que estar prevista desde el
principio. De ahí que el punto 4 de arriba sea de ahora aunque los roles sean de
después.

**Los tres verbos no son iguales**, y conviene decirlo antes de prometer nada:

| Verbo | Se controla |
|---|---|
| **Acceder** | **Sí, y criptográficamente.** Sin llave no hay lectura, y no depende de que ningún servidor se porte bien. |
| **Almacenar** | **No.** Quien descifró un mensaje puede quedárselo. |
| **Modificar / borrar para todos** | **No se impone.** Es una *petición* al resto de participantes, no una orden que se pueda hacer cumplir. |

No es un defecto que se corrija más adelante: es la propiedad del modelo, la misma
que el ecosistema ya enuncia —*ninguna app cuida lo que su dueño decide mostrar*—.
**No se promete borrado remoto ni control de copias**, porque no existen.

## 7. Altas y bajas

- **Alta**: no hay alta. Quien entra a la empresa ya está en Active Directory; la
  primera vez que abre el chat obtiene su atestación y entra.
- **Baja**: la atestación dura una jornada y **se renueva en silencio** mientras
  Active Directory siga reconociendo a la persona. El día que Recursos Humanos la
  desactiva, deja de renovarse y queda fuera sola, sin que nadie recorra las
  aplicaciones una por una. Es el mismo mecanismo de los certificados de
  dispositivo del vault (30 días con renovación automática), con la vigencia
  ajustada al caso.
- **Cambio de área**: se refleja en la siguiente renovación, con el mismo retraso
  máximo de una jornada.

**Límite honesto, y se dice de frente:** lo que alguien ya descifró es suyo. La
baja corta el acceso de ahí en adelante; no borra lo que se llevó puesto. *Ninguna
app cuida lo que su dueño decide mostrar.*

## 8. Entra ID / ADFS frente a LDAP crudo

| Vía | Cuándo | Nota |
|---|---|---|
| **OpenID Connect contra Entra ID o ADFS** | Por omisión, y con diferencia la preferible | El servicio **nunca** toca una contraseña: recibe un token de Microsoft. Menos superficie y menos responsabilidad. |
| **LDAP contra un Active Directory local** | Solo si la empresa no tiene federación | El `bind` ocurre **en el servidor de la empresa**, jamás cerca del navegador. Aun así, alguien escribe una contraseña en una pantalla que no es la de siempre: es el modo degradado, no el recomendado. |

Si se implementa la segunda vía, la documentación debe advertir esa diferencia sin
disimularla.

## 9. Privacidad

- La contraseña corporativa se escribe **solo** en la pantalla de Microsoft.
- La llave privada **no sale** del equipo del empleado, ni hacia su empresa.
- El servicio **no guarda** usuarios, ni contraseñas, ni historial de accesos: lee
  del directorio, firma y olvida. Lo único persistente es su par de llaves de
  firma.
- **Dotrino no participa** en tiempo de ejecución y no ve nada: el servicio es de
  la empresa y corre en su red.
- La empresa **sí** ve cuándo pide acceso cada empleado — es su directorio y su
  servicio, exactamente igual que hoy con el correo. Eso no se disimula.

## 10. Fases

| Fase | Qué | Repo |
|---|---|---|
| **0** | Destinatario y vigencia en el sobre firmado (`aud`, `nonce`, `exp`) | `dotrino-identity` — es la fase 1 de [`dotrino-sso`](../../dotrino-sso/docs/FASES.md) y es prerrequisito |
| **1** ✅ | Publicar y cablear `@dotrino/verifier`. **Hecho el 2026-09-07**: 0.2.0 añade el servicio `directory`, el destinatario (`aud`) y los `claims` de la atestación; el pilar sale de `dependencies` a `peerDependencies` | `dotrino-verifier` |
| **2** ✅ | El servicio: OIDC contra Entra ID → atestación firmada. **Hecho el 2026-09-07**, probado contra un Keycloak de verdad (`test/keycloak.e2e.mjs`) y con la atadura de §4.1 cubierta por una prueba que representa el ataque | este repo |
| **3** | Salas con política en el chat | `dotrino-chat` |
| **4** | Comprobación en el proxio (la puerta de verdad) | `dotrino-proxy` |
| **5** | Llave de sala condicionada a la atestación | `dotrino-chat` |
| **6** | Landing explicativa del servicio (§1.2 de convenciones) y alta en el catálogo | este repo + `dotrino-home` |

Las fases 3 a 5 son las que convierten esto en un producto; las 0 a 2 son la
plomería.

## 11. Decisiones

### Cerradas al implementar (2026-09-07)

| Tema | Qué se decidió, y por qué |
|---|---|
| **Quién emite el reto** | **El servicio** (`GET /challenge`), de un solo uso y cinco minutos. Si lo eligiera la aplicación, no se estaría comprobando frescura: una prueba capturada valdría igual. |
| **Cómo se ata la llave** | El `nonce` que va al directorio es el **hash de la llave que firmó la prueba**, deducido por el servicio. No se acepta que se lo digan. |
| **A qué aplicaciones sirve** | **Lista cerrada** (`AD_APPS`), y el retorno tiene que ser del mismo origen que el destinatario. Sin eso, el servicio es un redirector abierto con una firma de la empresa dentro. |
| **Cómo vuelve el respaldo** | Por el **`#fragment`** de la aplicación, que no llega a ningún servidor — ni al de ella. Es el patrón de siempre del ecosistema. |
| **Vigencia** | 12 h por omisión, configurable con `AD_TTL_HOURS`. Se deja sin tope duro: el que lo instala es el dueño del directorio, y ponerle un máximo desde aquí sería decidir por él. |
| **Grupos anidados** | Se firma **lo que el directorio diga**, sin resolver nada. Resolver de forma recursiva es política de la empresa y cada directorio la expresa a su manera; traducirla aquí sería inventarse una segunda lista de permisos, que es justo lo que §5 evita. |
| **LDAP crudo** | **No se implementa.** Solo OpenID Connect. El modo degradado obliga a alguien a escribir la contraseña de la empresa en una pantalla que no es la de siempre, que es el hábito exacto que este servicio existe para no enseñar. |

### Abiertas

| Tema | Pregunta |
|---|---|
| **Perfil de trabajo** | ¿La empresa exige un perfil aparte del personal, o acepta que el empleado use el suyo? Aparte es más limpio y evita mezclar; exige explicar el cambio de perfil (que hoy obliga a recargar). |
| **Sin conexión al directorio** | Si el servicio no alcanza Active Directory, ¿se sigue con la atestación vigente hasta que caduque, o se corta? |
| **Varias empresas** | ¿Un empleado puede tener atestaciones de dos organizaciones a la vez en el mismo perfil? |
| **Dispositivos conocidos** (§4.1) | Sin estado, cualquier llave que supere un acceso al directorio queda respaldada. ¿Se acepta, o se guarda una lista de dispositivos con aprobación del administrador —perdiendo el "no guarda nada"—? |
| **Roles y rotación de llave de sala** (§6.1) | Los roles finos son de después, pero la **rotación** de la llave al sacar a alguien tiene que estar prevista desde el principio. ¿Rotación automática en cada baja, o manual? |
| **Renovación** | El respaldo dura una jornada y §7 dice que se renueva «en silencio». Hoy renovarlo es rehacer el recorrido entero, con su paso por la pantalla de Microsoft. Que sea silencioso depende de que la sesión del directorio siga viva, y eso no lo decide este servicio. |
| **Distribución** | Contenedor, `.deb` o ambos. Si hay descargable, la versión va en el nombre del archivo (§11.5 de convenciones). |

## 12. Referencias

- [`CLAUDE.md`](../../CLAUDE.md) — posicionamiento, Dotrino Enterprise, reglas de
  privacidad y de redacción.
- [`CONVENCIONES-APPS.md`](../../CONVENCIONES-APPS.md) — §1.2 (landing de un
  servicio), §8.1 (el código va en inglés), §9.1 (lenguaje llano), §11.5
  (instaladores versionados).
- [`dotrino-sso/docs/DISENO.md`](../../dotrino-sso/docs/DISENO.md) — el camino
  inverso, y el formato del sobre firmado del que este servicio depende.
- [`dotrino-vault/docs/`](../../dotrino-vault/docs/) — acta del perfil,
  certificados de dispositivo y renovación automática.
