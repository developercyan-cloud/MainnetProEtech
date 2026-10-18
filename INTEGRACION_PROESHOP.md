# Integración posterior con el frontend existente de ProEshop

Este servicio se despliega por separado. Para que el selector WalletConnect existente reconozca la red, aplica estos cambios mínimos en una rama de pruebas de `static/app.js` **después** de desplegar el RPC y conocer su URL HTTPS. No reemplaces `main.py`, no cambies el Project ID y no toques `/data/shopcart.db`.

## 1. Añadir la red al mapa de tokens
En el objeto `networks` que usa la función `balance()`, añade una entrada equivalente a esta, conservando las entradas actuales:

```js
31337: {
  name: 'ProEshop Virtual Ethereum',
  token: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  decimals: 6
}
```

La dirección corresponde al contrato de USDT de Ethereum Mainnet. En el fork, su saldo puede modificarse para pruebas; no es USDT transferible en Mainnet.

## 2. Permitir la cadena en WalletConnect
En `EthereumProvider.init({...})`, agrega `31337` a `chains` y `optionalChains`, conservando las cadenas que ya usa la app. Añade `rpcMap` con la URL real que Railway asigne al nuevo servicio:

```js
rpcMap: {
  31337: 'https://TU-DOMINIO-DEL-SERVICIO.up.railway.app/rpc'
}
```

Si tu versión/configuración de WalletConnect no acepta la cadena personalizada, no elimines las cadenas actuales; prueba primero MetaMask con la red añadida manualmente y luego valida el soporte de WalletConnect por separado.

## 3. Separación estricta de pedidos
- Mantén esta red solo para staging/desarrollo.
- El backend de producción debe rechazar Chain ID `31337` al verificar pagos.
- Solo considera pagado un pedido real después de verificar una transacción en Ethereum Mainnet (Chain ID `1`) y el contrato oficial de USDT.
- No uses el saldo mostrado en el frontend como prueba de pago; la confirmación debe ocurrir en el backend.

## 4. Pruebas de aceptación
1. `/health` devuelve `ok: true` y `chainId: 31337`.
2. MetaMask puede añadir la red con la URL `/rpc`.
3. El endpoint administrativo acredita saldo a una dirección de prueba y verifica `balanceOf`.
4. La wallet muestra el saldo USDT al cambiar a Chain ID `31337`.
5. Una transferencia de prueba produce un recibo consultable por `/rpc`.
6. Un pedido de producción nunca pasa a pagado por una transacción de Chain ID `31337`.
