# Meu Proxy Minecraft (zero dependências)

Esse zip já tem **tudo**: o proxy (`server.js`) e o site do Minecraft (`public/index.html`).
O site já vem configurado pra usar o proxy do próprio endereço onde você hospedar. Não precisa configurar nada.

## Como subir no justrunmy.app
1. Cria um app novo, tipo **Node.js**, e faz upload desse zip.
2. Comando de start: `node server.js` (ou `npm start`). Não precisa de `npm install`.
3. O app lê a porta da variável `PORT` (a plataforma já define).
4. Abre a URL que ele te der. O Minecraft aparece. No campo de servidor, digita o IP normal (ex: `play.exemplo.com` ou `play.exemplo.com:25565`) e entra.

## Testar se o proxy está vivo
- `https://SEU-APP/health` deve mostrar `ok`
- `https://SEU-APP/api/vm/net/connect` deve mostrar `{"ok":true,...}`

## Usar o HTML em OUTRO site (ex: Neocities)
Abre o `minecraft.html` e muda a linha perto do topo:
    window.MC_PROXY_URL = "https://SEU-APP.justrunmy.app"
Ou, sem editar, abre assim: `https://seusite.neocities.org/minecraft?proxy=SEU-APP.justrunmy.app`

## Variáveis opcionais
| Variável | Pra quê |
|---|---|
| `ALLOWED_ORIGINS` | sites que podem usar o proxy (ex: `https://googleclient.neocities.org`). Padrão: todos (`*`) |
| `AUTH_TOKEN` | exige `?token=XXXX` na URL do site (pra ninguém usar seu proxy) |
| `MAX_PER_IP` | conexões por pessoa (padrão 8) |

## Segurança (já incluído)
- Bloqueia conexão a IPs internos/locais (anti-SSRF)
- Limite de conexões por IP e total
- Sem dependências externas

## Modo extra
Também aceita `wss://SEU-APP/ws/ip:porta` (túnel TCP simples), caso você queira usar em outro cliente.

## Problemas comuns
- Se o jogo ainda tentar o proxy antigo, limpa os dados do site (ou Reset App) pra apagar o proxy salvo.
- Server de Minecraft **premium (online-mode)** exige login Microsoft. Servers **cracked/offline** entram direto.


## Correção adicional de ligações (diagnóstico)
- Resolve registos DNS SRV `_minecraft._tcp` quando o jogador não indica uma porta explícita.
- Tenta endereços IPv4/IPv6 alternativos, preferindo IPv4 para alojamentos sem saída IPv6.
- Ativa TCP keepalive na ligação ao servidor.
- `/status` indica que o processo está online, mas **não prova** que o alojamento permita ligações TCP de saída. Para isso, tenta entrar num servidor e consulta os logs do processo.
- Se todos os destinos falharem com `ETIMEDOUT`, `ECONNREFUSED` ou `ENETUNREACH`, o bloqueio pode estar na rede/alojamento ou no próprio servidor. Nenhuma alteração de código consegue garantir acesso se a plataforma bloquear TCP de saída.


## ⚠️ GoDaddy Node.js Hosting NÃO serve para o proxy
O GoDaddy só deixa o teu app fazer ligações de saída para as portas **80 e 443** (HTTP/HTTPS).
Os servidores de Minecraft usam a porta **25565** (ou outra), por isso o GoDaddy corta a ligação
e o jogo mostra "erro do proxy" logo depois de carregar as texturas.
Não há nenhum código que contorne isto — é uma regra da rede deles.

**Solução:** mete o proxy (este zip) num host que deixe sair TCP — ex.: **Render** (grátis, já tem `render.yaml`),
Koyeb, Railway, ou uma VPS (Oracle Cloud Free). Se quiseres manter o site no GoDaddy,
põe no topo do `index.html`:
    window.MC_PROXY_URL = "https://O-TEU-PROXY.onrender.com"
