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

> **Estado: diseño, sin implementar.** Este repositorio contiene por ahora solo la
> documentación. Diseño completo en [`docs/DISENO.md`](./docs/DISENO.md).

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

## 6. Documentación

- [`docs/DISENO.md`](./docs/DISENO.md) — arquitectura, formato del respaldo
  firmado, salas con política, bajas, Entra ID frente a LDAP, qué hay que cambiar
  en el chat y en el proxio, fases y decisiones pendientes.
