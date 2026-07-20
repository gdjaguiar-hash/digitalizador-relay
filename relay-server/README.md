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
6. Configure manualmente (o Render nem sempre detecta o `render.yaml` sozinho
   se o serviço foi criado por fora do fluxo "Blueprint"):
   - **Root Directory**: `relay-server` — **obrigatório** se o repositório
     tiver uma pasta `relay-server` dentro dele (é o caso se você arrastou a
     pasta inteira pro GitHub). Se os arquivos (`server.js`, `package.json`)
     estiverem soltos na raiz do repositório, deixe este campo em branco.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
7. Clique em **Create Web Service** (ou, se o serviço já existir com erro de
   build, vá em **Settings** → preencha o **Root Directory** → salve → **Manual
   Deploy** → **Deploy latest commit**) e aguarde o deploy terminar (1-2 min).
8. Copie a URL que o Render gerou, algo como:
   `https://digitalizador-relay.onrender.com`

## Depois de publicar

Volte e me avise a URL gerada — eu configuro o app desktop pra usar esse
endereço e gero o `.exe` atualizado.

**Detalhe importante do plano gratuito do Render**: o serviço "dorme" depois
de alguns minutos sem uso, e a primeira requisição depois disso demora uns
20-30 segundos pra acordar. Isso significa que, se ninguém usar o "Enviar do
Celular" por um tempo, o primeiro QR Code depois disso pode demorar um pouco
a mais pra funcionar — mas depois de acordado, fica rápido normalmente. (O app
desktop já espera o relay acordar antes de mostrar o QR Code, então o celular
nunca chega a ver essa demora.)

## Publicando uma atualização do app desktop

O app verifica novas versões apontando pra `/updates` deste mesmo servidor
(`temp-app/package.json` -> `build.publish.url`). Pra publicar uma versão nova:

1. No `temp-app`, suba o número de `version` em `package.json`.
2. Rode `npm run dist:installer` — gera em `temp-app/release/` o instalador
   (`Digitalizador-Setup-X.Y.Z.exe`) e o `latest.yml`.
3. Copie esses dois arquivos pra dentro da pasta `relay-server/updates/`
   (crie a pasta se não existir).
4. Suba/dê deploy dessa pasta pro Render junto com o resto do `relay-server`
   (mesmo fluxo do passo "Como publicar no Render" acima).
5. Pronto — na próxima vez que o app verificar atualizações, ele vai encontrar
   essa versão em `https://digitalizador-relay.onrender.com/updates/latest.yml`.
