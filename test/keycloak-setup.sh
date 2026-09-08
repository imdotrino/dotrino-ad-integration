#!/usr/bin/env bash
# Levanta un DIRECTORIO DE PRUEBA (Keycloak) con lo mínimo para probar este servicio de
# punta a punta: un realm que hace de empresa, una persona con su UPN y sus grupos, y el
# cliente OpenID Connect con los dos `claims` que el puente necesita.
#
# No es Active Directory, y no hace falta que lo sea: lo que este servicio consume es
# OpenID Connect, exactamente lo que hablan Entra ID y ADFS. Lo que cambia en producción
# son las URLs y de dónde salen `upn` y `groups` (ver README §«Contra Entra ID de verdad»).
#
#   ./test/keycloak-setup.sh          # levanta el contenedor y prepara el realm
#   node test/keycloak.e2e.mjs        # el recorrido entero contra él
#   docker rm -f kc-prueba            # y a la basura
set -euo pipefail

KC=${KC_BASE:-http://localhost:8095}
NAME=${KC_NAME:-kc-prueba}
PORT=${KC_PORT:-8095}

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "levantando $NAME en :$PORT"
  docker run -d --name "$NAME" -p "$PORT:8080" \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    quay.io/keycloak/keycloak:26.0 start-dev >/dev/null
fi

echo -n "esperando a Keycloak"
until curl -sf "$KC/realms/master/.well-known/openid-configuration" >/dev/null; do echo -n .; sleep 2; done
echo " listo"

T=$(curl -s -d client_id=admin-cli -d username=admin -d password=admin -d grant_type=password \
  "$KC/realms/master/protocol/openid-connect/token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
api() { curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' "$@"; }

api -X POST "$KC/admin/realms" -d '{"realm":"empresa","enabled":true}' >/dev/null || true

# LOS ATRIBUTOS NO DECLARADOS SE DESCARTAN, y en silencio. Keycloak 26 no guarda un `upn`
# que no esté permitido en el perfil del realm, y la política vive en `users/profile` — no
# en el objeto realm, donde ponerla se acepta y no hace nada. Va ANTES de crear a nadie.
api "$KC/admin/realms/empresa/users/profile" | python3 -c '
import json,sys
p = json.load(sys.stdin); p["unmanagedAttributePolicy"] = "ENABLED"
open("/tmp/kc-perfil.json","w").write(json.dumps(p))'
api -X PUT "$KC/admin/realms/empresa/users/profile" -d @/tmp/kc-perfil.json >/dev/null

for g in Ingenieria Todos; do
  api -X POST "$KC/admin/realms/empresa/groups" -d "{\"name\":\"$g\"}" >/dev/null || true
done

api -X POST "$KC/admin/realms/empresa/users" -d '{
  "username":"maria","email":"maria@empresa.com","firstName":"María","lastName":"Ruiz",
  "enabled":true,"emailVerified":true,"requiredActions":[],
  "attributes":{"upn":["maria@empresa.com"]},
  "credentials":[{"type":"password","value":"prueba1234","temporary":false}],
  "groups":["/Ingenieria","/Todos"]}' >/dev/null || true

api -X POST "$KC/admin/realms/empresa/clients" -d '{
  "clientId":"dotrino-ad","enabled":true,"protocol":"openid-connect",
  "publicClient":false,"secret":"secreto-de-prueba",
  "standardFlowEnabled":true,
  "redirectUris":["http://localhost:8099/callback"]}' >/dev/null || true

CID=$(api "$KC/admin/realms/empresa/clients?clientId=dotrino-ad" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
api -X POST "$KC/admin/realms/empresa/clients/$CID/protocol-mappers/models" -d '{
  "name":"groups","protocol":"openid-connect","protocolMapper":"oidc-group-membership-mapper",
  "config":{"claim.name":"groups","full.path":"false","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}}' >/dev/null || true
api -X POST "$KC/admin/realms/empresa/clients/$CID/protocol-mappers/models" -d '{
  "name":"upn","protocol":"openid-connect","protocolMapper":"oidc-usermodel-attribute-mapper",
  "config":{"user.attribute":"upn","claim.name":"upn","jsonType.label":"String","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}}' >/dev/null || true

echo "realm «empresa» listo: maria / prueba1234 · grupos Ingenieria, Todos · cliente dotrino-ad"
echo "consola: $KC  (admin/admin)"
