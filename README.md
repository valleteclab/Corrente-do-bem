# Corrente do Bem 💛

Site para organizar as doações de uma campanha que viralizou.

A ideia: muita gente quer ajudar a mesma pessoa, e ela acaba recebendo mais do que precisa de alguns itens.
Em vez de recusar, a plataforma **repassa a doação para outra pessoa que também precisa**.

## O que o sistema faz

**Página pública**

- Mostra a história e a lista do que a beneficiária **ainda precisa** e do que **já recebeu**.
- **Quero ajudar**: quem quer doar escolhe um item da lista (ou descreve o que tem) e deixa um contato.
  - Se o item já foi recebido, o site avisa na hora e a doação entra na fila de repasse.
  - O doador escolhe se autoriza o repasse automático ou se prefere ser consultado antes.
- **Preciso de ajuda**: outras pessoas registram o que precisam. Só o primeiro nome e a cidade ficam públicos.
- **Quem precisa**: lista pública dos pedidos abertos. O doador pode doar direto para uma pessoa.
- **Como funciona**: explica a corrente e mostra os números (doações repassadas, pedidos atendidos).

**Painel (`/admin`, protegido por senha)**

- Cadastrar os itens que ela precisa e marcar como **recebido**. Ao marcar, as ofertas pendentes daquele item
  viram "disponíveis para repasse" automaticamente.
- Ver todas as ofertas, com contato do doador (link direto para o WhatsApp).
- **Repassar** uma oferta para um pedido aberto, marcar como entregue, cancelar, anotar observações.
- Gerenciar os pedidos de ajuda (atendido, cancelado).
- Editar nome da campanha, história, link do vídeo e WhatsApp de contato.

Contatos (WhatsApp, e-mail) nunca aparecem no site público.

**IA de repasse (Claude)**

Com a variável `ANTHROPIC_API_KEY` definida, cada oferta de doação passa pela Claude API, que:

1. Entende o que o doador quer doar, mesmo escrito com outras palavras ("prótese dentária" = "dentadura",
   "rancho" = "cesta básica"), e liga a oferta ao item certo da lista da beneficiária.
2. Se esse item **já foi recebido** e o doador autorizou, marca a doação como disponível para repasse na hora.
3. Sugere, com pontuação de 0 a 100 e um motivo, para quais pedidos de outras pessoas a doação pode ir.
   A organização vê as sugestões no painel e repassa com um clique.

A IA só sugere. Quem confirma o repasse é sempre a organização. Contatos nunca são enviados para a API, só
o item, a categoria, a cidade e a descrição. O doador não fica esperando: se a análise demorar mais que
15 segundos, ele já vê a página de obrigado e a análise termina em segundo plano.

Sem a chave, o site funciona do mesmo jeito, só sem as sugestões automáticas.

## Rodando

Precisa do Node.js 22.13 ou mais novo (usa o SQLite embutido do Node, sem compilar nada).

```bash
npm install
cp .env.example .env     # edite ADMIN_PASSWORD e SESSION_SECRET
export $(cat .env | xargs)
npm start
```

Abra http://localhost:3000. O painel fica em http://localhost:3000/admin.

Para desenvolvimento com reinício automático: `npm run dev`.

Testes: `npm test`.

## Variáveis de ambiente

| Variável         | Obrigatória | Descrição                                                    |
| ---------------- | ----------- | ------------------------------------------------------------ |
| `ADMIN_PASSWORD`     | sim         | Senha do painel. Sem ela o `/admin` fica desativado.                    |
| `SESSION_SECRET`     | recomendada | Segredo para assinar os cookies. Se vazia, usa a senha.                  |
| `ANTHROPIC_API_KEY`  | não         | Chave da Claude API. Ativa a IA de repasse.                              |
| `IA_MODELO`          | não         | Modelo da IA (padrão `claude-opus-5-5`).                                 |
| `IA_TEMPO_LIMITE_MS` | não         | Quanto o doador espera pela análise antes de ver o "obrigado" (`15000`). |
| `PORT`               | não         | Porta do servidor (padrão `3000`; o Railway define sozinho).             |
| `DATABASE_PATH`      | não         | Caminho do arquivo SQLite (padrão `./data/corrente.db`).                 |

## Publicando no Railway

O banco é um arquivo SQLite, então o serviço precisa de um **volume** (disco persistente). Sem volume, cada
deploy apaga os dados.

1. No [Railway](https://railway.com), **New Project → Deploy from GitHub repo** e escolha este repositório.
   O arquivo `railway.json` já diz como buildar e iniciar (`npm start`, healthcheck em `/health`).
2. No serviço criado, aba **Variables**, adicione:
   - `ADMIN_PASSWORD` = a senha do painel
   - `SESSION_SECRET` = um texto longo e aleatório
   - `ANTHROPIC_API_KEY` = sua chave da Claude API (opcional, ativa a IA)
   - `DATABASE_PATH` = `/data/corrente.db`
3. Clique com o botão direito no serviço → **Add Volume** (ou aba **Settings → Volumes**) e monte em `/data`.
4. Em **Settings → Networking → Generate Domain** para ter uma URL pública. Depois dá para apontar um domínio próprio.
5. Faça o deploy (ou só dê push na branch conectada). Abra a URL gerada; o painel fica em `/admin`.

Backup: no Railway, o volume tem snapshot nas configurações. Ou baixe o arquivo `corrente.db` de vez em quando.

Também roda em Render, Fly.io ou qualquer VPS com Node 22: mesma receita, volume + variáveis. Não serve para
Vercel/Netlify (sem disco persistente).

## Fluxo de status

**Necessidade** (item que ela precisa): `aberta` → `recebida`

**Oferta** (alguém quer doar):

| Status       | Significa                                                          |
| ------------ | ------------------------------------------------------------------ |
| `nova`       | Chegou agora, ninguém olhou ainda.                                 |
| `aceita`     | Vai para a beneficiária, falta combinar a entrega.                 |
| `disponivel` | Ela já tem esse item. A doação pode ser repassada.                 |
| `repassada`  | Já foi vinculada a um pedido de outra pessoa.                      |
| `concluida`  | Entregue (para ela ou para quem recebeu o repasse).                |
| `cancelada`  | Doador desistiu ou não respondeu.                                  |

**Pedido** (alguém precisa de ajuda): `aberto` → `atendido` ou `cancelado`

Quando uma oferta repassada é marcada como entregue, o pedido vinculado vira `atendido` sozinho.

## Estrutura

```
src/server.js          configuração do Express
src/db.js              banco SQLite e regras (status, repasse)
src/ia.js              integração com a Claude API (análise e sugestões de repasse)
src/routes/publico.js  páginas públicas e formulários
src/routes/admin.js    painel
views/                 templates EJS
public/style.css       estilo (mobile-first)
test/                  testes (node:test)
```
