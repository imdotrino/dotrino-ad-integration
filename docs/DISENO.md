# Diseño — `dotrino-ad-integration` (Active Directory como respaldo de identidad)

> **Estado:** diseño abierto, **sin implementar**. Fija el *qué* y el *cómo*, y
> deja marcadas las decisiones pendientes (§11).
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
| **1** | Publicar y cablear `@dotrino/verifier` (escrito, con tests verdes, sin publicar) | `dotrino-verifier` |
| **2** | El servicio: OIDC contra Entra ID → atestación firmada | este repo |
| **3** | Salas con política en el chat | `dotrino-chat` |
| **4** | Comprobación en el proxio (la puerta de verdad) | `dotrino-proxy` |
| **5** | Llave de sala condicionada a la atestación | `dotrino-chat` |
| **6** | Landing explicativa del servicio (§1.2 de convenciones) y alta en el catálogo | este repo + `dotrino-home` |

Las fases 3 a 5 son las que convierten esto en un producto; las 0 a 2 son la
plomería.

## 11. Decisiones pendientes

| Tema | Pregunta |
|---|---|
| **Perfil de trabajo** | ¿La empresa exige un perfil aparte del personal, o acepta que el empleado use el suyo? Aparte es más limpio y evita mezclar; exige explicar el cambio de perfil (que hoy obliga a recargar). |
| **LDAP crudo** | ¿Se implementa el modo degradado o se exige federación? Exigirla deja fuera a empresas pequeñas con AD local. |
| **Grupos anidados** | Active Directory los tiene; ¿se resuelven de forma recursiva al firmar, o se toma solo la pertenencia directa? |
| **Vigencia** | Una jornada es una propuesta. Una empresa con requisitos estrictos querrá una hora; una con portátiles fuera de línea querrá una semana. ¿Configurable, con un máximo? |
| **Sin conexión al directorio** | Si el servicio no alcanza Active Directory, ¿se sigue con la atestación vigente hasta que caduque, o se corta? |
| **Varias empresas** | ¿Un empleado puede tener atestaciones de dos organizaciones a la vez en el mismo perfil? |
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
