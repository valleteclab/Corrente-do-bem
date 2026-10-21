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
| `ADMIN_PASSWORD` | sim         | Senha do painel. Sem ela o `/admin` fica desativado.        |
| `SESSION_SECRET` | recomendada | Segredo para assinar os cookies. Se vazia, usa a senha.      |
| `PORT`           | não         | Porta do servidor (padrão `3000`).                           |
| `DATABASE_PATH`  | não         | Caminho do arquivo SQLite (padrão `./data/corrente.db`).     |

## Publicando

O banco é um arquivo SQLite, então o servidor precisa de **disco persistente**. Funciona bem em:

- **Render / Railway / Fly.io**: crie um volume, aponte `DATABASE_PATH` para dentro dele (ex.: `/var/data/corrente.db`)
  e defina `ADMIN_PASSWORD` e `SESSION_SECRET` nas variáveis do serviço. Comando de start: `npm start`.
- **VPS** (qualquer máquina com Node): rode com `pm2` ou um serviço `systemd` e coloque Nginx/Caddy na frente com HTTPS.

Não serve para Vercel/Netlify (sem disco persistente).

Faça backup do arquivo `corrente.db` de vez em quando. É só copiar o arquivo.

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
src/routes/publico.js  páginas públicas e formulários
src/routes/admin.js    painel
views/                 templates EJS
public/style.css       estilo (mobile-first)
test/                  testes (node:test)
```
