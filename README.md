# ProEshop Anvil Virtual Ethereum — Railway

Servicio separado para pruebas EVM. No modifica el backend FastAPI, `static/app.js`, WalletConnect ni `/data/shopcart.db` de ProEshop.

## Qué incluye
- Anvil/Foundry ejecutando una bifurcación de Ethereum Mainnet.
- Chain ID de prueba `31337`.
- RPC HTTPS detrás del dominio público de Railway, mediante una pasarela que permite solo métodos JSON-RPC de Ethereum necesarios para wallets.
- Métodos `anvil_*`, `hardhat_*`, `evm_*`, `personal_*` y `eth_sendTransaction` NO se exponen públicamente.
- Endpoint administrativo con bearer token para acreditar saldo de prueba en el contrato original de USDT de Ethereum dentro del fork, validando el resultado de `balanceOf`.
- Archivo de estado Anvil en volumen persistente.
- Fondeo opcional de ETH de prueba para gas.

## Seguridad y límites
**Este servicio es exclusivamente para pruebas.** Aunque se conserva la dirección oficial del contrato USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`, el estado de la bifurcación es artificial. No son fondos reales, no tienen valor, y no se pueden transferir a Mainnet.

No conectes este RPC a la lógica de pagos de producción ni uses los recibos de esta red para confirmar pedidos reales. Usa esta red únicamente en un entorno de pruebas o con un interruptor de entorno explícito que bloquee la conciliación de pagos de producción.

El gateway no publica los métodos de administración de Anvil. El token `ADMIN_TOKEN` debe ser secreto, aleatorio, de al menos 32 caracteres y solo debe usarse en llamadas administrativas. El RPC público es para pruebas y puede ser abusado; aplica límites de uso y monitoriza el consumo de Railway.

La bifurcación requiere un proveedor RPC de Ethereum Mainnet. Su plan puede tener límites/costo aunque Anvil sea gratuito. El servicio Railway y el almacenamiento persistente también pueden generar costos. “Ilimitado” significa que controlas el software y los saldos locales, no que la infraestructura sea gratuita o infinita.

## Despliegue en Railway
1. Crea un repositorio GitHub nuevo con el contenido de esta carpeta.
2. En Railway, añade un servicio nuevo conectado a ese repositorio. No reemplaces el servicio de ProEshop.
3. Añade un **Volume** al nuevo servicio con mount path `/data`.
4. Configura estas variables:
   - `ETHEREUM_RPC_URL`: URL RPC de Ethereum Mainnet de un proveedor de tu elección.
   - `ADMIN_TOKEN`: secreto aleatorio de 32+ caracteres.
   - `CHAIN_ID`: `31337` (por defecto).
   - `DATA_DIR`: `/data` (por defecto).
   - `RPC_RATE_LIMIT_PER_MINUTE`: `300` (opcional).
5. Genera un dominio HTTPS público para el servicio.
6. Espera a que `/health` responda `{"ok":true,...}`.
7. No añadas el servicio como pago real en ProEshop.

## Conectar MetaMask / Trust Wallet
Añade una red personalizada:
- Nombre: `ProEshop Virtual Ethereum`
- RPC URL: `https://TU-DOMINIO-RAILWAY.up.railway.app/rpc`
- Chain ID: `31337`
- Símbolo: `ETH`
- Explorador: dejar vacío

Añade el token personalizado:
- Dirección: `0xdAC17F958D2ee523a2206206994597C13D831ec7`
- Decimales: `6`
- Símbolo: `USDT`

MetaMask y Trust Wallet pueden variar en el soporte para redes personalizadas dentro de Telegram. Si Telegram no permite añadirla, prueba primero desde el navegador de la wallet o el navegador externo. No se cambia el Project ID de WalletConnect.

## Acreditar saldo USDT de prueba
Desde un terminal que tengas bajo tu control, sustituye los valores y ejecuta:

```bash
curl -X POST "https://TU-DOMINIO-RAILWAY.up.railway.app/admin/fund-usdt" \
  -H "Authorization: Bearer TU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address":"0xDIRECCION_DE_PRUEBA","amount":"2500","gasEth":"5"}'
```

El endpoint busca el slot de `balanceOf` en la implementación original de USDT, cambia el storage solo en Anvil y verifica el resultado mediante `balanceOf`. Si no encuentra un slot que pase la verificación, devuelve error y no retiene los cambios de los intentos fallidos.

Para guardar una instantánea manual (se restaura al iniciar el servicio; el archivo automático de Anvil se conserva separado):
```bash
curl -X POST "https://TU-DOMINIO-RAILWAY.up.railway.app/admin/snapshot" \
  -H "Authorization: Bearer TU_ADMIN_TOKEN"
```

## Prueba rápida
```bash
curl https://TU-DOMINIO-RAILWAY.up.railway.app/health
curl -X POST https://TU-DOMINIO-RAILWAY.up.railway.app/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```
El Chain ID debe ser `0x7a69` (31337).

## Compatibilidad con ProEshop
Esta implementación está aislada y no modifica el backend actual. La configuración de red en la interfaz WalletConnect requerirá una modificación posterior de la configuración de redes en `static/app.js` para agregar el Chain ID `31337` y mostrar el saldo en esta red. No reemplaces los archivos actuales sin probar primero la conexión en un entorno de staging.
