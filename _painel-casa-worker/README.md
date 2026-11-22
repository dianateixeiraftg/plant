# Painel da Casa: Worker

Pequeno intermediário grátis (Cloudflare Worker) que guarda as chaves da Fox ESS e da Shelly e fala com elas por ti. A página `Tools/Painel_da_Casa.html` só fala com este Worker e tem de enviar o PIN. Esta pasta começa por `_`, por isso o GitHub Pages não a publica.

## 1. Criar o Worker (sem terminal)

1. Cria uma conta grátis em cloudflare.com.
2. **Workers & Pages → Create → Start with Hello World**, chama-lhe `painel-casa` e carrega em **Deploy**.
3. **Edit code**, apaga o que lá está, cola o conteúdo de `worker.js` e carrega em **Deploy**.
4. Anota o endereço do Worker (algo como `https://painel-casa.o-teu-nome.workers.dev`).

## 2. Definir variáveis e segredos

No Worker: **Settings → Variables and Secrets**.

| Nome | Tipo | Valor |
|---|---|---|
| `ALLOWED_ORIGIN` | Text | `https://dianateixeiraftg.github.io` (sem barra no fim) |
| `PIN` | Secret | uma frase longa que escolhes (12 caracteres ou mais) |
| `FOX_API_KEY` | Secret | chave de API da Fox ESS |
| `FOX_SN` | Secret | número de série do inversor |
| `SHELLY_AUTH_KEY` | Secret | chave de autorização da Shelly Cloud |
| `SHELLY_HOST` | Secret | servidor da Shelly Cloud, por exemplo `shelly-12-eu.shelly.cloud` |
| `SHELLY_DEVICES` | Secret | lista dos relés (exemplo abaixo) |

Exemplo de `SHELLY_DEVICES` (até 10 dispositivos):

```json
[{"id":"a1b2c3d4e5f6","name":"Luz da sala","channel":0},
 {"id":"112233445566","name":"Tomada do escritório","channel":0}]
```

### Onde ficam as chaves (confirma na tua app)

- **Fox ESS:** no site foxesscloud.com, no perfil, em gestão de API, gera uma chave. O número de série vê-se na lista de dispositivos.
- **Shelly:** na app Shelly, em definições do utilizador, pede a chave de autorização da cloud. Mostra a chave e o servidor. O ID de cada dispositivo está em Dispositivo → Definições → Informação do dispositivo.

Nunca escrevas estas chaves no repositório, que é público.

## 3. Ligar a página

Abre a página no dispositivo que vai ficar em casa, escreve o endereço do Worker e o PIN, e carrega em **Guardar e ligar**. Ficam guardados só nesse dispositivo.

## O que não foi testado

Só foi testado com respostas simuladas. Nenhum pedido real chegou à Fox ESS ou à Shelly. Se algo falhar, a página mostra a mensagem do erro no módulo. Os pontos mais prováveis:

- **Fox ESS, assinatura:** é o MD5 de `caminho\r\nchave\r\ntimestamp` com os `\r\n` escritos como texto. Se aparecer "illegal signature", o ponto a rever é `FOX_PATH` e este formato em `worker.js`.
- **Fox ESS, "Hoje":** a documentação indica a unidade do campo `todayYield` como kW, o que é estranho para uma energia. A página mostra a unidade que a API devolver.
- **Shelly:** o formato da resposta da API v2 foi lido da documentação. Gen1 e Gen2 estão previstos, mas confirma com os teus relés.

## Limites a respeitar

- Fox ESS: 1440 chamadas por dia por inversor. O Worker guarda a resposta 2 minutos e a página atualiza de 2 em 2 minutos.
- Shelly: 1 pedido por segundo. O Worker junta todos os relés num só pedido.
- O PIN trava tentativas rápidas, mas não bloqueia ataques lentos. Usa uma frase longa.

## Testes

```
node worker.test.mjs
```
