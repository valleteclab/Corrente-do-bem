# Elo Brasil 🇧🇷

Rede para conectar pessoas e empresas que compartilham os mesmos valores: comércio local, vagas de trabalho,
feed por cidade e ajuda mútua. Todo perfil passa por **verificação de identidade** (selfie com documento +
foto do documento + Instagram) ou entra por **convite** de um membro verificado.

O nome, o slogan e os textos são configuráveis no painel. As cores seguem a bandeira do Brasil.

## O que o sistema faz

**Rede (público e membros)**

- **Conta** de pessoa ou empresa, com login por e-mail e senha. Consentimento LGPD destacado no cadastro.
- **Selo** (nome configurável, padrão "Patriota"), dois caminhos:
  - **Convite** de quem já tem o selo: o convidado entra **com o selo na hora**, sem análise. Quem convidou ganha pontos
    e responde pela indicação.
  - **Análise**: o membro informa redes sociais (Instagram, Facebook, TikTok, X, YouTube) e/ou envia até 3 fotos.
    A moderação olha e aprova. As fotos ficam em área privada e são **apagadas automaticamente** após a decisão.
- **Convites**: membro com selo ganha 5 convites. O convidado fica ligado a quem convidou.
- **Gamificação para puxar o comércio entre membros**: depois de comprar ou contratar, o cliente registra o negócio no
  perfil da empresa; a empresa confirma e **os dois ganham 25 pontos**. Pontos também por selo, convites aceitos, perfil
  completo, avaliações, vagas, candidaturas e posts (limite diário). Níveis (Recruta → Patriota → Guardião →
  Bandeirante → Lenda), conquistas (Primeiro Elo, Comerciante, Anfitrião...) e **ranking** de empresas e membros por cidade.
- **Diretório** de empresas, profissionais e membros verificados: busca por nome, cidade, tipo e categoria.
  Avaliações (1 a 5 estrelas) só por membros verificados. WhatsApp visível só para membros verificados.
- **Vagas**: empresas verificadas publicam; membros verificados se candidatam com um clique. A empresa vê o perfil
  e o contato de quem se candidatou. Vagas são abertas a todos os membros.
- **Feed** estilo Instagram: publicações com texto, até 4 fotos ou 1 vídeo (**Reels**), curtidas, comentários, página
  por publicação para compartilhar, filtro por cidade, denúncias. Links do Instagram e do YouTube no texto viram
  embeds (o conteúdo continua hospedado lá; não baixamos fotos de terceiros).
- **Currículo e Talentos**: pessoas preenchem profissão, resumo e PDF opcional, marcam "procurando trabalho" e aparecem
  na página Talentos para as empresas. PDF visível só para membros com selo. Qualquer membro com selo publica vagas.
- **Corrente do Bem** (`/corrente`): o módulo de ajuda da rede. Membros com selo criam **campanhas** para alguém que
  precisa (história, foto, lista do que falta, link para compartilhar) e cuidam delas: marcam o que chegou, aceitam
  e confirmam entregas. Qualquer pessoa, membro ou não, registra um **pedido** ou oferece uma **doação** (para um item
  de campanha, para um pedido, ou livre). O que uma campanha já recebeu é **repassado** para o próximo da fila, com
  sugestão da IA. Doação entregue dá 20 pontos a quem doou; criar campanha dá 10.

**Moderação (`/admin`)**

- Entra com a senha `ADMIN_PASSWORD` ou com uma conta de membro com papel **moderador** (painel inteiro) ou
  **verificador** (só a fila do selo: aprovar/recusar). Papéis são dados em Membros. Cada decisão registra quem decidiu.
- **Fila de verificação**: vê as imagens, a recomendação da IA, aprova ou recusa com motivo.
- **Membros**: busca, verificar manualmente, tirar selo, dar convites, tornar moderador, suspender.
- **Denúncias**: remover publicação, suspender conta, resolver.
- **Corrente do Bem**: itens de todas as campanhas, ofertas (com repasse por IA) e pedidos. A moderação também
  pode gerenciar qualquer campanha.
- **Configurações**: nome da rede, slogan, descrição, nome do selo, cadastro aberto ou só por convite, textos da Corrente.

**IA (Claude API)**, ativa com `ANTHROPIC_API_KEY`:

- **Triagem do selo**: olha as fotos e os dados informados e diz se parecem de um perfil real e consistente
  (sem acesso à internet, não abre os perfis). Recomenda aprovar / revisar / rejeitar. **A decisão é sempre da
  moderação.** A IA não avalia aparência, religião ou opinião política de ninguém.
- **Repasse de doações** (Corrente do Bem): liga a oferta ao item certo e sugere para quem repassar.

## Rodando

Precisa do Node.js 22.13 ou mais novo (SQLite embutido, sem compilar nada).

```bash
npm install
cp .env.example .env     # edite ADMIN_PASSWORD, SESSION_SECRET e, se quiser IA, ANTHROPIC_API_KEY
export $(cat .env | xargs)
npm start
```

Abra http://localhost:3000. Painel em http://localhost:3000/admin. Testes: `npm test`.

## Variáveis de ambiente

| Variável             | Obrigatória | Descrição                                                                 |
| -------------------- | ----------- | ------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | sim         | Senha do painel de moderação.                                             |
| `SESSION_SECRET`     | recomendada | Segredo dos cookies de sessão. Se vazia, usa a senha.                     |
| `ANTHROPIC_API_KEY`  | não         | Chave da Claude API. Ativa a triagem de verificação e o repasse por IA.   |
| `IA_MODELO`          | não         | Modelo da IA (padrão `claude-opus-5-5`).                                  |
| `DATABASE_PATH`      | não         | Arquivo SQLite (padrão `./data/corrente.db`). Uploads ficam na mesma pasta.|
| `URL_BASE`           | não         | URL pública (para os links de convite). Se vazia, usa o host da requisição.|
| `PORT`               | não         | Porta (padrão `3000`; o Railway define sozinho).                          |

## Publicando no Railway

Já está publicado em https://corrente-do-bem-production.up.railway.app com volume em `/data`.
Para um projeto novo:

1. **New Project → Deploy from GitHub repo**. O `railway.json` define build, `npm start` e healthcheck `/health`.
2. **Variables**: `ADMIN_PASSWORD`, `SESSION_SECRET`, `ANTHROPIC_API_KEY` (opcional), `DATABASE_PATH=/data/corrente.db`.
3. **Add Volume** montado em `/data` (banco e fotos ficam lá; sem volume os dados somem a cada deploy).
4. **Settings → Networking → Generate Domain**.

## Privacidade e lei (resumo do que foi considerado)

- Opinião política é dado sensível na LGPD. Como esta é uma rede de afinidade, a própria participação pode revelar
  convicções; por isso o cadastro pede **consentimento específico e destacado** (art. 11, I) e os termos explicam
  isso. O sistema não tem campo de ideologia declarada: o selo é dado por convite ou pela moderação.
- Fotos enviadas para o selo são apagadas após a decisão. Só a moderação vê.
- Vagas são abertas a todos os membros verificados; a empresa decide quem contrata. Os termos lembram as empresas
  da legislação (Constituição art. 3º IV, Lei 9.029/95, Convenção 111 da OIT).
- `views/rede/termos.ejs` tem uma versão inicial dos termos. Vale revisão jurídica antes do lançamento.

## Estrutura

```
src/server.js           Express, middlewares, montagem das rotas
src/db.js               SQLite: config + Corrente do Bem
src/db-rede.js          SQLite: usuários, convites, verificações, posts, denúncias, vagas, avaliações
src/auth.js             sessão por cookie e guardas (login, verificado, empresa)
src/upload.js           uploads (fotos públicas / verificação privada)
src/gamificacao.js      pontos por ação, níveis, conquistas
src/ia.js               Claude API: triagem de verificação e repasse de doações
src/routes/auth.js      entrar, cadastrar, sair
src/routes/rede.js      feed, diretório, perfil, verificação, convites, vagas
src/routes/publico.js   Corrente do Bem (montado em /corrente)
src/routes/admin.js     moderação (+ /admin/corrente/*)
views/rede/             telas da rede
views/corrente/         telas da Corrente do Bem
views/admin/            painel de moderação
public/style.css        estilo verde-amarelo-azul, mobile-first
test/                   node:test (rede, corrente, IA)
```
