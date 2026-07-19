# Relay do "Enviar do Celular"

Servidor pequeno e sem banco de dados: só repassa fotos do celular para o
Digitalizador no PC. Nada é salvo em disco — tudo fica em memória (RAM) até
o PC buscar, e é descartado na hora.

## Por que isso existe

Sem esse servidor, o celular precisaria se conectar direto no PC pela rede
Wi-Fi local, o que esbarra na configuração de rede privada/pública do Windows
e no firewall. Com o relay, o PC e o celular só fazem conexões de **saída**
para este servidor — nenhum firewall de rede local atrapalha, e nem precisa
mais estar na mesma Wi-Fi (funciona até com o celular no 4G/5G).

## Como publicar no Render (gratuito, ~5 minutos)

1. **Crie uma conta no GitHub**, se ainda não tiver: https://github.com/signup
2. **Crie um repositório novo** (pode ser público) e suba só a pasta
   `relay-server` (este arquivo, `server.js`, `package.json` e `render.yaml`).
   - Pelo site do GitHub: "New repository" → dê um nome (ex: `digitalizador-relay`)
     → "uploading an existing file" → arraste os arquivos desta pasta.
3. **Crie uma conta no Render**: https://render.com (não pede cartão de crédito
   para o plano gratuito).
4. No painel do Render, clique em **New +** → **Web Service**.
5. Conecte sua conta do GitHub e escolha o repositório que você criou.
6. O Render deve detectar o `render.yaml` automaticamente (plano **Free**,
   comando de build `npm install`, comando de start `npm start`). Se pedir
   pra confirmar manualmente:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
7. Clique em **Create Web Service** e aguarde o deploy terminar (1-2 minutos).
8. Copie a URL que o Render gerou, algo como:
   `https://digitalizador-relay.onrender.com`

## Depois de publicar

Volte e me avise a URL gerada — eu configuro o app desktop pra usar esse
endereço e gero o `.exe` atualizado.

**Detalhe importante do plano gratuito do Render**: o serviço "dorme" depois
de alguns minutos sem uso, e a primeira requisição depois disso demora uns
20-30 segundos pra acordar. Isso significa que, se ninguém usar o "Enviar do
Celular" por um tempo, o primeiro QR Code depois disso pode demorar um pouco
a mais pra funcionar — mas depois de acordado, fica rápido normalmente.
